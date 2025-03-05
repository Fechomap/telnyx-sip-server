import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { createLogger, format, transports } from 'winston';
import TelnyxService from './services/telnyxService.js';
import { delay } from './utils/helpers.js';

// Constantes para delays
const DELAYS = {
  ANSWER_CALL: 200,
  SPEAK_MESSAGE: 200,
  MENU_DELAY: 500
};

// Configuración de voces para diferentes momentos
const VOICE_CONFIG = {
  BIENVENIDA: {
    voice: "Polly.Andres-Neural",
    language: "es-MX"
  },
  MENU: {
    voice: "Polly.Andres-Neural",
    language: "es-MX"
  },
  INFO: {
    voice: "Polly.Andres-Neural",
    language: "es-MX"
  }
};

// Mensajes del sistema
const MENSAJES = {
  BIENVENIDA: "Bienvenido a CrK Asistencia. Ingrese su número de expediente seguido de numeral",
  REINGRESO_EXPEDIENTE: "Expediente no encontrado. Intente nuevamente",
  ERROR_GENERAL: "Ocurrió un error. Intente más tarde",
  ERROR_PROCESAMIENTO: "Ocurrió un error procesando su solicitud",
  NO_INFO_COSTOS: "No se encontró información de costos",
  NO_INFO_UNIDAD: "No se encontró información de la unidad",
  OPCION_INVALIDA: "Opción no válida",
  MENU_CONCLUIDO: "Presione 1 para costos, 2 para datos de unidad, 3 para tiempos, 5 para consultar otro expediente",
  MENU_EN_PROCESO: "Presione 1 para costos, 2 para datos de unidad, 3 para ubicación, 4 para tiempos, 5 para consultar otro expediente",
  // Nuevo mensaje de transferencia
  TRANSFERENCIA: "Expediente no encontrado. Transferiremos su llamada a un agente."
};

// Inicialización del logger
const logger = createLogger({
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(format.colorize(), format.simple())
    }),
    new transports.File({ filename: 'error.log', level: 'error' })
  ]
});

// Inicialización de Express
const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

const transferredCalls = new Set();

// Verificar variables de entorno
if (!process.env.TELNYX_API_KEY || !process.env.API_BASE_URL) {
  logger.error('❌ Variables de entorno faltantes');
  process.exit(1);
}

// Inicialización del servicio Telnyx y almacenamiento de llamadas activas
const telnyxService = new TelnyxService();
const activeCalls = new Map();

// Handler del Webhook
app.post('/webhook', async (req, res) => {
  const event = req.body;
  const eventType = event.event_type || event?.data?.event_type;
  const payload = event.payload || event?.data?.payload;

  if (!eventType || !payload) {
    logger.error('⚠️ Payload del webhook inválido');
    return res.sendStatus(400);
  }

  const callControlId = payload.call_control_id;
  const callId = payload.call_leg_id || callControlId;

  logger.info(`🔔 Webhook: ${eventType} para llamada ${callId}`);

  try {
    switch (eventType) {
      case 'call.initiated':
        await handleIncomingCall(callControlId, callId, payload);
        break;
      case 'call.speak.ended':
        if (!activeCalls.get(callId)?.gatheringDigits) {
          await handleSpeakEnded(callControlId, callId);
        }
        break;
      case 'call.gather.ended':
        await handleGatherEnded(callControlId, callId, payload);
        break;
      case 'call.hangup':
        await handleCallHangup(callId, payload);
        break;
      // Agregar manejo para dtmf.received (para barge-in)
      case 'call.dtmf.received':
        await handleDtmfReceived(callControlId, callId, payload);
        break;
    }
  } catch (error) {
    logger.error('Error manejando evento:', error);
  }

  res.sendStatus(200);
});

// Manejo de llamada entrante
// Actualiza la función handleIncomingCall para manejar mejor los errores

async function handleIncomingCall(callControlId, callId, payload) {
  const { from, to } = payload;
  logger.info(`📞 Nueva llamada de ${from} a ${to}`);

  try {
    // Verificar si la llamada es una transferencia (número destino diferente al principal)
    const esTransferencia = to === process.env.NUMERO_SOPORTE;
    
    if (esTransferencia) {
      logger.info(`⚠️ Llamada ${callId} identificada como transferencia a ${to}. No se procesará automáticamente.`);
      return; // No procesar automáticamente las llamadas transferidas
    }
    
    activeCalls.set(callId, {
      state: 'initiated',
      gatheringDigits: false,
      etapa: 'esperando_expediente',
      intentos: 0
    });

    await delay(DELAYS.ANSWER_CALL);
    
    try {
      await telnyxService.answerCall(callControlId);
    } catch (error) {
      // Si falla al contestar, verificar si es por un estado incorrecto (422)
      if (error.response && error.response.status === 422) {
        logger.warn(`⚠️ No se pudo contestar la llamada ${callId}: ya está en otro estado`);
        activeCalls.delete(callId);
        return;
      }
      // Para cualquier otro error, relanzarlo
      throw error;
    }

    await delay(DELAYS.SPEAK_MESSAGE);
    // Mensaje de bienvenida
    await telnyxService.speakText(
      callControlId,
      MENSAJES.BIENVENIDA,
      VOICE_CONFIG.BIENVENIDA
    );
  } catch (error) {
    logger.error('Error en handleIncomingCall:', error);
    activeCalls.delete(callId);
  }
}

// Manejo de speak.ended
async function handleSpeakEnded(callControlId, callId) {
  const call = activeCalls.get(callId);
  if (!call) return;

  try {
    // Verificar si hay una transferencia pendiente específica
    if (call.transferPending === true) {
      // Verificar si esta llamada ya fue transferida
      if (transferredCalls.has(callId)) {
        logger.info(`⚠️ La llamada ${callId} ya fue transferida previamente, ignorando evento duplicado`);
        return;
      }
      
      logger.info(`🔊 Mensaje de transferencia completado para ${callId}, procediendo con la transferencia`);
      
      // Marcar que ya no está pendiente para evitar transferencias múltiples
      activeCalls.set(callId, { ...call, transferPending: false });
      
      // Pequeña pausa para asegurar que el mensaje se ha reproducido completamente
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Transferir a número fijo
      const numeroSoporte = process.env.NUMERO_SOPORTE || "5510112858";
      
      try {
        await telnyxService.transferCall(callControlId, numeroSoporte);
        // Marcar esta llamada como ya transferida para evitar duplicados
        transferredCalls.add(callId);
        logger.info(`✅ Llamada ${callId} transferida exitosamente a ${numeroSoporte}`);
      } catch (error) {
        logger.error(`❌ Error al transferir llamada: ${error.message}`);
        // Si la transferencia falla, terminar la llamada amablemente
        await telnyxService.speakText(
          callControlId,
          "No fue posible transferir su llamada. Por favor, intente más tarde.",
          VOICE_CONFIG.INFO
        );
        setTimeout(() => telnyxService.hangupCall(callControlId), 3000);
      }
      return;
    }
    
    // Si no es transferencia, seguir con el flujo normal
    if (call.etapa !== 'transferencia') {
      activeCalls.set(callId, { ...call, gatheringDigits: true });
      await telnyxService.gatherDigits(
        callControlId,
        null, // Sin instrucción repetida
        "0123456789#",
        10
      );
    }
  } catch (error) {
    logger.error(`Error en handleSpeakEnded: ${error.message}`);
    activeCalls.delete(callId);
  }
}

// Manejo de gather.ended
async function handleGatherEnded(callControlId, callId, payload) {
  const call = activeCalls.get(callId);
  if (!call) return;

  const digits = payload.digits;
  logger.info(`📞 Dígitos recibidos: ${digits}`);

  try {
    if (call.etapa === 'esperando_expediente') {
      const expedienteData = await telnyxService.obtenerExpediente(digits);
      if (expedienteData) {
        // Expediente encontrado: reiniciamos contador y pasamos al menú principal
        activeCalls.set(callId, {
          ...call,
          etapa: 'menu_principal',
          expediente: digits,
          datosExpediente: expedienteData,
          intentos: 0
        });

        const mensaje = `Expediente encontrado. ${expedienteData.nombre}. ` +
          `Vehículo: ${expedienteData.vehiculo}. ` +
          `Estado: ${expedienteData.estatus}. ` +
          `Servicio: ${expedienteData.servicio}. ` +
          `Destino: ${expedienteData.destino}. `;

        const menuOpciones = expedienteData.estatus === 'Concluido'
          ? MENSAJES.MENU_CONCLUIDO
          : MENSAJES.MENU_EN_PROCESO;

        await telnyxService.speakText(
          callControlId,
          mensaje,
          VOICE_CONFIG.INFO
        );

        await delay(DELAYS.SPEAK_MESSAGE);

        // Presentar menú completo
        await telnyxService.gatherDigits(
          callControlId,
          menuOpciones,
          expedienteData.estatus === 'Concluido' ? "12345" : "12345",
          1,
          VOICE_CONFIG.MENU
        );
      } else {
        // Incrementar intentos PRIMERO
        call.intentos++;
        
        // Luego verificar si es el segundo fallo
        if (call.intentos >= 2) {
          // Marcar la llamada como en proceso de transferencia
          activeCalls.set(callId, {
            ...call,
            etapa: 'transferencia',
            gatheringDigits: false,
            transferPending: true   // Flag para la transferencia
          });
          
          logger.info(`🔄 Iniciando proceso de transferencia para llamada ${callId} (intento ${call.intentos})`);
          
          // Reproducir SOLAMENTE el mensaje de transferencia
          // La transferencia real ocurrirá en handleSpeakEnded cuando el mensaje termine
          await telnyxService.speakText(
            callControlId,
            MENSAJES.TRANSFERENCIA,
            VOICE_CONFIG.INFO
          );
          
          // NO hacer nada más aquí - la transferencia será manejada por speak.ended
        } else {
          // Actualizar el objeto call en el mapa con el nuevo valor de intentos
          activeCalls.set(callId, { ...call, intentos: call.intentos });
          
          logger.info(`⚠️ Expediente no encontrado para ${callId} (intento ${call.intentos} de 2)`);
          
          await telnyxService.speakText(
            callControlId,
            MENSAJES.REINGRESO_EXPEDIENTE,
            VOICE_CONFIG.INFO
          );
          await delay(DELAYS.SPEAK_MESSAGE);
          await handleSpeakEnded(callControlId, callId);
        }
      }
    } else if (call.etapa === 'menu_principal') {
      await procesarOpcionMenu(callControlId, callId, digits);
    }
  } catch (error) {
    logger.error('Error en handleGatherEnded:', error);
    await telnyxService.speakText(
      callControlId,
      MENSAJES.ERROR_GENERAL,
      VOICE_CONFIG.INFO
    );
    setTimeout(() => telnyxService.hangupCall(callControlId), 3000);
  }
}

// Procesamiento de opciones del menú principal
async function procesarOpcionMenu(callControlId, callId, opcion) {
  const call = activeCalls.get(callId);
  if (!call) return;
  let respuesta = '';
  const expediente = call.expediente;

  try {
    switch (opcion) {
      case '1': {
        const costos = await telnyxService.obtenerExpedienteCosto(expediente);
        if (costos) {
          let desglose = '';
          if (call.datosExpediente.servicio === 'Local') {
            desglose = `${costos.km} kilómetros, plano ${costos.plano}`;
          } else if (call.datosExpediente.servicio === 'Carretero') {
            desglose = `${costos.km} kilómetros, ${costos.banderazo ? `banderazo ${costos.banderazo}, ` : ''}${costos.costoKm ? `costo por kilómetro ${costos.costoKm}` : ''}`;
          }
          respuesta = `El costo total es ${costos.costo}. ${desglose}`;
        } else {
          respuesta = MENSAJES.NO_INFO_COSTOS;
        }
        break;
      }
      case '2': {
        const unidad = await telnyxService.obtenerExpedienteUnidadOp(expediente);
        if (unidad) {
          respuesta = `Datos de la unidad: Operador ${unidad.operador || 'No asignado'}. ` +
            `Tipo de Grúa: ${unidad.tipoGrua || 'No especificado'}. ` +
            `Número Económico: ${unidad.unidadOperativa || 'No disponible'}. ` +
            `Placas: ${unidad.placas || unidad.placa || 'No disponible'}.`;
        } else {
          respuesta = MENSAJES.NO_INFO_UNIDAD;
        }
        break;
      }
      case '3': {
        if (call.datosExpediente.estatus === 'Concluido') {
          const tiempos = await telnyxService.obtenerExpedienteTiempos(expediente);
          respuesta = `Tiempos del servicio: Contacto en ${tiempos.tc}, Término en ${tiempos.tt}.`;
        } else {
          const ubicacion = await telnyxService.obtenerExpedienteUbicacion(expediente);
          respuesta = `Tiempo estimado de llegada: ${ubicacion.tiempoRestante || 'No disponible'}.`;
        }
        break;
      }
      case '4': {
        if (call.datosExpediente.estatus !== 'Concluido') {
          const tiempos = await telnyxService.obtenerExpedienteTiempos(expediente);
          respuesta = `Tiempos del servicio: Contacto en ${tiempos.tc}, Término en ${tiempos.tt}.`;
        }
        break;
      }
      case '5': {
        // Opción para consultar otro expediente
        activeCalls.set(callId, { ...call, etapa: 'esperando_expediente', intentos: 0 });
        await telnyxService.speakText(
          callControlId,
          "Por favor, ingrese el nuevo número de expediente.",
          VOICE_CONFIG.INFO
        );
        await delay(DELAYS.SPEAK_MESSAGE);
        await telnyxService.gatherDigits(callControlId, null, "0123456789#", 10);
        return;
      }
      default:
        respuesta = MENSAJES.OPCION_INVALIDA;
    }

    await telnyxService.speakText(callControlId, respuesta, VOICE_CONFIG.INFO);

    // Re-presentar el menú principal tras un breve delay
    setTimeout(async () => {
      const menuOpciones = call.datosExpediente.estatus === 'Concluido'
        ? MENSAJES.MENU_CONCLUIDO
        : MENSAJES.MENU_EN_PROCESO;
      await telnyxService.gatherDigits(
        callControlId,
        menuOpciones,
        "0123456789",
        1,
        VOICE_CONFIG.MENU
      );
    }, DELAYS.MENU_DELAY);
  } catch (error) {
    logger.error('Error procesando opción:', error);
    await telnyxService.speakText(
      callControlId,
      MENSAJES.ERROR_PROCESAMIENTO,
      VOICE_CONFIG.INFO
    );
  }
}

// Manejo de colgado de llamada
async function handleCallHangup(callId, payload) {
  logger.info('📞 Llamada finalizada:', { callId, motivo: payload.hangup_cause });
  // Limpiar las estructuras de datos
  activeCalls.delete(callId);
  transferredCalls.delete(callId);
}

// 2. Crear la función handleDtmfReceived para manejar el barge-in

async function handleDtmfReceived(callControlId, callId, payload) {
  const call = activeCalls.get(callId);
  if (!call) return;
  
  // Si ya está recolectando dígitos, no hacer nada
  if (call.gatheringDigits) return;
  
  // Si está en la etapa inicial de bienvenida
  if (call.etapa === 'esperando_expediente' && !call.bargeInBuffer) {
    // Iniciar un buffer para acumular dígitos DTMF
    logger.info(`🎮 Barge-in detectado, iniciando captura de dígitos para ${callId}`);
    
    // Detener el mensaje actual si está hablando
    try {
      await telnyxService.telnyxApi.post(`/calls/${encodeURIComponent(callControlId)}/actions/stop_speaking`, {
        command_id: `stop_${Date.now()}`
      });
      logger.info(`🔇 Mensaje detenido por barge-in en ${callId}`);
    } catch (error) {
      logger.warn(`No se pudo detener el mensaje: ${error.message}`);
    }
    
    // Inicializar el buffer de dígitos con el primer dígito
    activeCalls.set(callId, {
      ...call,
      bargeInBuffer: payload.digit,
      bargeInTimestamp: Date.now()
    });
    
    // Configurar un timeout para procesar los dígitos después de cierto tiempo sin nuevos dígitos
    setTimeout(() => procesarBargeIn(callControlId, callId), 3000);
  } 
  // Si ya tiene un buffer de barge-in, añadir el nuevo dígito
  else if (call.bargeInBuffer) {
    // Si es #, procesar inmediatamente
    if (payload.digit === '#') {
      // Añadir # al buffer
      activeCalls.set(callId, {
        ...call,
        bargeInBuffer: call.bargeInBuffer + payload.digit
      });
      
      // Procesar inmediatamente
      procesarBargeIn(callControlId, callId);
    } else {
      // Añadir el dígito al buffer
      activeCalls.set(callId, {
        ...call,
        bargeInBuffer: call.bargeInBuffer + payload.digit,
        bargeInTimestamp: Date.now()
      });
      
      // Reiniciar el timeout
      setTimeout(() => procesarBargeIn(callControlId, callId), 3000);
    }
  }
}

// 3. Función para procesar los dígitos acumulados en barge-in

async function procesarBargeIn(callControlId, callId) {
  const call = activeCalls.get(callId);
  if (!call || !call.bargeInBuffer) return;
  
  // Si pasó demasiado tiempo desde el último dígito, o si hay suficientes dígitos
  const ahora = Date.now();
  const tiempoTranscurrido = ahora - call.bargeInTimestamp;
  
  // Si han pasado menos de 2 segundos y no hay #, puede que aún haya más dígitos
  if (tiempoTranscurrido < 2000 && !call.bargeInBuffer.includes('#')) {
    return;
  }
  
  logger.info(`🎮 Procesando barge-in para ${callId}: ${call.bargeInBuffer}`);
  
  // Eliminar # si está presente
  let digits = call.bargeInBuffer;
  if (digits.endsWith('#')) {
    digits = digits.slice(0, -1);
  }
  
  // Limpiar el buffer de barge-in
  activeCalls.set(callId, {
    ...call,
    bargeInBuffer: null,
    bargeInTimestamp: null
  });
  
  // Crear un payload falso para simular un gather.ended
  const simulatedPayload = {
    digits: digits
  };
  
  // Procesar como si fuera un gather.ended normal
  await handleGatherEnded(callControlId, callId, simulatedPayload);
}

// Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 Servidor SIP corriendo en puerto ${PORT}`);
});

export default app;