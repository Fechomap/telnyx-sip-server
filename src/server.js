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
  BIENVENIDA: "Bienvenido a CrK Asistencia. Ingrese su número de expediente",
  REINGRESO_EXPEDIENTE: "Expediente no encontrado. Intente nuevamente",
  ERROR_GENERAL: "Ocurrió un error. Intente más tarde",
  ERROR_PROCESAMIENTO: "Ocurrió un error procesando su solicitud",
  NO_INFO_COSTOS: "No se encontró información de costos",
  NO_INFO_UNIDAD: "No se encontró información de la unidad",
  OPCION_INVALIDA: "Opción no válida",
  MENU_CONCLUIDO: "Presione 1 para costos, 2 para datos de unidad, 3 para tiempos, 5 para consultar otro expediente",
  MENU_EN_PROCESO: "Presione 1 para costos, 2 para datos de unidad, 3 para ubicación, 4 para tiempos, 5 para consultar otro expediente",
  LIMITE_EXPEDIENTES: "Ha alcanzado el límite de 10 expedientes consultados en esta llamada. Gracias por utilizar nuestro servicio.",
  SEGUNDA_CONSULTA: "Esta es la segunda consulta de este expediente. Después de esta, deberá consultar un expediente diferente.",
  EXPEDIENTE_YA_CONSULTADO: "Usted ya ha consultado este expediente dos veces. Por favor, realice una nueva llamada. Hasta luego.",
  TRANSFERENCIA: "Expediente no encontrado. Transferiremos su llamada a un agente."
};

// Constante para reintentos de transferencia
const MAX_TRANSFER_ATTEMPTS = 3;
const MAX_CALL_DURATION = 300000; // 5 minutos en milisegundos


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

// Health check endpoint para Kubernetes
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

const transferredCalls = new Set();


// Verificar variables de entorno
if (!process.env.TELNYX_API_KEY || !process.env.API_BASE_URL) {
  logger.error('❌ Variables de entorno faltantes');
  process.exit(1);
}

// Inicialización del servicio Telnyx y almacenamiento de llamadas activas
const telnyxService = new TelnyxService();
const activeCalls = new Map();


// Función de transferencia con reintentos
async function transferCallWithRetries(callControlId, callId, destinationNumber, attempt = 1) {
  try {
    // Obtener la referencia a la llamada actual
    const call = activeCalls.get(callId);
    if (!call) return false;
    
    // Si no es el primer intento, anunciar que vamos a reintentar
    if (attempt > 1) {
      logger.info(`🗣️ Reproduciendo mensaje de reintento antes del intento ${attempt}`);
      
      try {
        // Mensaje de reintento
        await telnyxService.speakText(
          callControlId,
          "No pudimos contactar a un agente, intentando nuevamente en unos momentos...",
          VOICE_CONFIG.INFO
        );
        
        // Esperar a que termine de reproducirse el mensaje
        // Esto es importante para asegurar que el mensaje se escuche completo
        await new Promise(resolve => {
          const messageTimeout = setTimeout(resolve, 6000); // 6 segundos para el mensaje
          
          // Guardar referencia al timeout para poder cancelarlo si es necesario
          activeCalls.set(callId, {
            ...activeCalls.get(callId),
            messageTimeoutId: messageTimeout
          });
        });
        
        logger.info(`✅ Mensaje de reintento reproducido completamente`);
      } catch (messageError) {
        logger.error(`❌ Error al reproducir mensaje de reintento: ${messageError.message}`);
        // Continuar con la transferencia incluso si el mensaje falla
      }
    }
    
    // Registrar el intento actual
    logger.info(`🔄 Intento ${attempt} de ${MAX_TRANSFER_ATTEMPTS} para transferir llamada ${callId} a ${destinationNumber}`);
    
    // Realizar el intento de transferencia
    await telnyxService.transferCall(callControlId, destinationNumber);
    
    // Marcar la llamada como en proceso de transferencia y guardar datos relevantes
    activeCalls.set(callId, {
      ...call,
      transferIntento: attempt,
      transferEnCurso: true,
      transferIniciado: Date.now()
    });
    
    // Configurar un timeout para el caso en que nadie conteste
    const timeoutMs = attempt === MAX_TRANSFER_ATTEMPTS ? 30000 : 20000; // Último intento espera un poco más
    
    // Esperar a que termine la transferencia (sea contestada o timeout)
    await new Promise((resolve, reject) => {
      const transferTimeout = setTimeout(async () => {
        try {
          const currentCall = activeCalls.get(callId);
          if (!currentCall || !currentCall.transferEnCurso) {
            resolve(false);
            return;
          }
          
          logger.warn(`⏰ Timeout de transferencia para llamada ${callId} (intento ${attempt})`);
          
          if (attempt < MAX_TRANSFER_ATTEMPTS) {
            // Todavía tenemos más intentos - ir al siguiente
            const success = await transferCallWithRetries(callControlId, callId, destinationNumber, attempt + 1);
            resolve(success);
          } else {
            // Se agotaron los intentos
            await handleTransferFailed(callControlId, callId);
            resolve(false);
          }
        } catch (error) {
          logger.error(`Error en timeout de transferencia: ${error.message}`);
          reject(error);
        }
      }, timeoutMs);
      
      // Guardar referencia al timeout para poder cancelarlo
      activeCalls.set(callId, {
        ...activeCalls.get(callId),
        transferTimeoutId: transferTimeout
      });
    });
    
    return true;
  } catch (error) {
    // Error al iniciar la transferencia
    logger.error(`❌ Error en intento ${attempt} de transferencia: ${error.message}`);
    
    if (attempt < MAX_TRANSFER_ATTEMPTS) {
      logger.info(`🔄 Pasando al siguiente intento debido a error en API`);
      return transferCallWithRetries(callControlId, callId, destinationNumber, attempt + 1);
    } else {
      await handleTransferFailed(callControlId, callId);
      return false;
    }
  }
}

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
async function handleIncomingCall(callControlId, callId, payload) {
  const { from, to } = payload;
  logger.info(`📞 Nueva llamada de ${from} a ${to}`);
  try {
    const esTransferencia = to === process.env.NUMERO_SOPORTE;
    if (esTransferencia) {
      logger.info(`⚠️ Llamada ${callId} identificada como transferencia a ${to}. No se procesará automáticamente.`);
      return;
    }
    
    // Configuración inicial de la llamada
    activeCalls.set(callId, {
      state: 'initiated',
      gatheringDigits: false,
      etapa: 'esperando_expediente',
      intentos: 0,
      expedientesConsultados: 0,
      expedienteActual: null,
      consultasPorExpediente: new Map(),
      bargeInBuffer: null,
      bargeInTimestamp: null,
      startTime: Date.now() // Registrar el tiempo de inicio
    });
    
    // Configurar temporizador para finalizar la llamada después de MAX_CALL_DURATION
    const maxDurationTimeout = setTimeout(() => handleMaxDuration(callControlId, callId), MAX_CALL_DURATION);
    
    // Guardar referencia al timeout para poder cancelarlo si la llamada termina antes
    activeCalls.set(callId, { 
      ...activeCalls.get(callId), 
      maxDurationTimeoutId: maxDurationTimeout 
    });
    
    await delay(DELAYS.ANSWER_CALL);
    
    try {
      await telnyxService.answerCall(callControlId);
    } catch (error) {
      if (error.response && error.response.status === 422) {
        logger.warn(`⚠️ No se pudo contestar la llamada ${callId}: ya está en otro estado`);
        activeCalls.delete(callId);
        clearTimeout(maxDurationTimeout); // Limpiar el timeout
        return;
      }
      throw error;
    }
    
    try {
      await telnyxService.startNoiseSuppression(callControlId, 'both');
      logger.info(`✅ Supresión de ruido activada para llamada ${callId}`);
    } catch (suppressionError) {
      logger.warn(`⚠️ No se pudo activar la supresión de ruido: ${suppressionError.message}`);
      // Continuar con la llamada aunque la supresión de ruido falle
    }
    
    await delay(DELAYS.SPEAK_MESSAGE);
    await telnyxService.speakText(callControlId, MENSAJES.BIENVENIDA, VOICE_CONFIG.BIENVENIDA);
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
    if (call.transferPending === true) {
      if (transferredCalls.has(callControlId)) {
        logger.info(`⚠️ La llamada ${callControlId} ya fue transferida previamente, ignorando evento duplicado`);
        return;
      }
      logger.info(`🔊 Mensaje de transferencia completado para ${callControlId}, procediendo con la transferencia`);
      activeCalls.set(callId, { ...call, transferPending: false });
      
      // Aumentar ligeramente esta pausa también
      await new Promise(resolve => setTimeout(resolve, 1000)); // Incrementado de 500ms a 1000ms
      
      const numeroSoporte = process.env.NUMERO_SOPORTE || "7226001968";
      // Asegúrate de pasar los tres parámetros en el orden correcto
      await transferCallWithRetries(callControlId, callId, numeroSoporte);
      return;
    }
    if (call.etapa !== 'transferencia') {
      activeCalls.set(callId, { ...call, gatheringDigits: true });
      await telnyxService.gatherDigits(callControlId, null, "0123456789#", 10);
    }
  } catch (error) {
    logger.error(`Error en handleSpeakEnded: ${error.message}`);
  }
}

// Manejo de gather.ended
async function handleGatherEnded(callControlId, callId, payload) {
  const call = activeCalls.get(callId);
  if (!call) return;
  const digits = payload.digits;
  logger.info(`📞 Dígitos recibidos: ${digits}`);
  try {
    const expedientesConsultados = call.expedientesConsultados || 0;
    const consultasPorExpediente = call.consultasPorExpediente || new Map();
    if (call.etapa === 'esperando_expediente') {
      if (expedientesConsultados >= 10) {
        logger.info(`⚠️ Límite de expedientes alcanzado para ${callId}`);
        await telnyxService.speakText(callControlId, MENSAJES.LIMITE_EXPEDIENTES, VOICE_CONFIG.INFO);
        setTimeout(() => telnyxService.hangupCall(callControlId), 5000);
        return;
      }
      if (consultasPorExpediente.has(digits) && consultasPorExpediente.get(digits) >= 2) {
        logger.info(`⚠️ Expediente ${digits} ya consultado dos veces en ${callId}`);
        await telnyxService.speakText(callControlId, MENSAJES.EXPEDIENTE_YA_CONSULTADO, VOICE_CONFIG.INFO);
        setTimeout(() => telnyxService.hangupCall(callControlId), 5000);
        return;
      }
      const expedienteData = await telnyxService.obtenerExpediente(digits);
      if (expedienteData) {
        const consultasMap = new Map(consultasPorExpediente);
        const consultasActuales = consultasPorExpediente.get(digits) || 0;
        consultasMap.set(digits, consultasActuales + 1);
        let mensajeAdicional = "";
        if (consultasActuales === 1) {
          mensajeAdicional = MENSAJES.SEGUNDA_CONSULTA + " ";
        }
        activeCalls.set(callId, {
          ...call,
          etapa: 'menu_principal',
          expediente: digits,
          datosExpediente: expedienteData,
          intentos: 0,
          expedientesConsultados: expedientesConsultados + 1,
          expedienteActual: digits,
          consultasPorExpediente: consultasMap,
          lastActivity: Date.now()
        });
        const mensaje = `${mensajeAdicional}Expediente encontrado. ${expedienteData.nombre}. ` +
          `Vehículo: ${expedienteData.vehiculo}. Estado: ${expedienteData.estatus}. Servicio: ${expedienteData.servicio}. ` +
          `Destino: ${expedienteData.destino}. `;
        const menuOpciones = expedienteData.estatus === 'Concluido'
          ? MENSAJES.MENU_CONCLUIDO
          : MENSAJES.MENU_EN_PROCESO;
        await telnyxService.speakText(callControlId, mensaje, VOICE_CONFIG.INFO);
        await delay(DELAYS.SPEAK_MESSAGE / 3); // Reducido para mayor fluidez
        await telnyxService.gatherDigits(callControlId, menuOpciones, "12345", 1, VOICE_CONFIG.MENU);
      } else {
        const updatedCall = { 
          ...call, 
          intentos: (call.intentos || 0) + 1,
          lastActivity: Date.now()
        };
        if (updatedCall.intentos >= 2) {
          activeCalls.set(callId, {
            ...updatedCall,
            etapa: 'transferencia',
            gatheringDigits: false,
            transferPending: true
          });
          logger.info(`🔄 Iniciando proceso de transferencia para llamada ${callId} (intento ${updatedCall.intentos})`);
          await telnyxService.speakText(callControlId, MENSAJES.TRANSFERENCIA, VOICE_CONFIG.INFO);
          // La transferencia se ejecutará en handleSpeakEnded al finalizar el mensaje
        } else {
          activeCalls.set(callId, updatedCall);
          logger.info(`⚠️ Expediente no encontrado para ${callId} (intento ${updatedCall.intentos} de 2)`);
          await telnyxService.speakText(callControlId, MENSAJES.REINGRESO_EXPEDIENTE, VOICE_CONFIG.INFO);
          await delay(DELAYS.SPEAK_MESSAGE / 3);
          await handleSpeakEnded(callControlId, callId);
        }
      }
    } else if (call.etapa === 'menu_principal') {
      await procesarOpcionMenu(callControlId, callId, digits);
    }
  } catch (error) {
    logger.error('Error en handleGatherEnded:', error);
    await telnyxService.speakText(callControlId, MENSAJES.ERROR_GENERAL, VOICE_CONFIG.INFO);
    setTimeout(() => telnyxService.hangupCall(callControlId), 3000);
  }
}

// Procesamiento de opciones del menú principal
async function procesarOpcionMenu(callControlId, callId, opcion) {
  const call = activeCalls.get(callId);
  if (!call) return;
  activeCalls.set(callId, { ...call, lastActivity: Date.now() });
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
        const expedientesConsultados = call.expedientesConsultados || 0;
        if (expedientesConsultados >= 10) {
          logger.info(`⚠️ Límite de expedientes alcanzado para ${callId}`);
          await telnyxService.speakText(callControlId, MENSAJES.LIMITE_EXPEDIENTES, VOICE_CONFIG.INFO);
          setTimeout(() => telnyxService.hangupCall(callControlId), 5000);
          return;
        }
        activeCalls.set(callId, { 
          ...call, 
          etapa: 'esperando_expediente', 
          intentos: 0,
          lastActivity: Date.now()
        });
        await telnyxService.speakText(callControlId, "Por favor, ingrese el nuevo número de expediente.", VOICE_CONFIG.INFO);
        await delay(DELAYS.SPEAK_MESSAGE / 3);
        await telnyxService.gatherDigits(callControlId, null, "0123456789#", 10);
        return;
      }
      default:
        respuesta = MENSAJES.OPCION_INVALIDA;
    }
    await telnyxService.speakText(callControlId, respuesta, VOICE_CONFIG.INFO);
    setTimeout(async () => {
      const menuOpciones = call.datosExpediente.estatus === 'Concluido'
        ? MENSAJES.MENU_CONCLUIDO
        : MENSAJES.MENU_EN_PROCESO;
      await telnyxService.gatherDigits(callControlId, menuOpciones, "12345", 1, VOICE_CONFIG.MENU);
    }, DELAYS.MENU_DELAY / 2);
  } catch (error) {
    logger.error('Error procesando opción:', error);
    await telnyxService.speakText(callControlId, MENSAJES.ERROR_PROCESAMIENTO, VOICE_CONFIG.INFO);
  }
}

// Manejo de colgado de llamada
async function handleCallHangup(callId, payload) {
  logger.info('📞 Llamada finalizada:', { callId, motivo: payload.hangup_cause });
  
  // Obtener el callControlId
  const call = activeCalls.get(callId);
  if (call) {
    // Limpiar timeout de hangup si existe
    if (call.hangupTimeoutId) {
      clearTimeout(call.hangupTimeoutId);
    }
    
    // Limpiar timeout de duración máxima
    if (call.maxDurationTimeoutId) {
      clearTimeout(call.maxDurationTimeoutId);
    }
    
    // Solo intentar detener la supresión si no se marcó como ya detenida
    if (payload.call_control_id && !call.suppressionStopped) {
      try {
        await telnyxService.stopNoiseSuppression(payload.call_control_id);
        logger.info(`✅ Supresión de ruido desactivada para llamada ${callId}`);
      } catch (error) {
        logger.warn(`⚠️ No se pudo desactivar la supresión de ruido: ${error.message}`);
      }
    } else if (call.suppressionStopped) {
      logger.info(`ℹ️ Supresión de ruido ya fue desactivada previamente para llamada ${callId}`);
    }
  }
  
  activeCalls.delete(callId);
  transferredCalls.delete(callId);
}

// Manejo de DTMF para barge-in
async function handleDtmfReceived(callControlId, callId, payload) {
  const call = activeCalls.get(callId);
  if (!call) return;
  if (call.gatheringDigits) return;
  if (call.etapa === 'esperando_expediente' && !call.bargeInBuffer) {
    logger.info(`🎮 Barge-in detectado, iniciando captura de dígitos para ${callId}`);
    try {
      await telnyxService.telnyxApi.post(`/calls/${encodeURIComponent(callControlId)}/actions/stop_speaking`, {
        command_id: `stop_${Date.now()}`
      });
      logger.info(`🔇 Mensaje detenido por barge-in en ${callId}`);
    } catch (error) {
      logger.warn(`No se pudo detener el mensaje: ${error.message}`);
    }
    activeCalls.set(callId, {
      ...call,
      bargeInBuffer: payload.digit,
      bargeInTimestamp: Date.now(),
      lastActivity: Date.now()
    });
    setTimeout(() => procesarBargeIn(callControlId, callId), 3000);
  } else if (call.bargeInBuffer) {
    if (payload.digit === '#') {
      activeCalls.set(callId, {
        ...call,
        bargeInBuffer: call.bargeInBuffer + payload.digit,
        lastActivity: Date.now()
      });
      procesarBargeIn(callControlId, callId);
    } else {
      activeCalls.set(callId, {
        ...call,
        bargeInBuffer: call.bargeInBuffer + payload.digit,
        bargeInTimestamp: Date.now(),
        lastActivity: Date.now()
      });
      setTimeout(() => procesarBargeIn(callControlId, callId), 3000);
    }
  }
}

// Procesar dígitos acumulados en barge-in
async function procesarBargeIn(callControlId, callId) {
  const call = activeCalls.get(callId);
  if (!call || !call.bargeInBuffer) return;
  const ahora = Date.now();
  const tiempoTranscurrido = ahora - (call.bargeInTimestamp || 0);
  if (tiempoTranscurrido < 2000 && !call.bargeInBuffer.includes('#')) {
    return;
  }
  logger.info(`🎮 Procesando barge-in para ${callId}: ${call.bargeInBuffer}`);
  let digits = call.bargeInBuffer;
  if (digits.endsWith('#')) {
    digits = digits.slice(0, -1);
  }
  activeCalls.set(callId, { ...call, bargeInBuffer: null, bargeInTimestamp: null });
  const simulatedPayload = { digits };
  await handleGatherEnded(callControlId, callId, simulatedPayload);
}

// Función para manejar cuando todos los intentos de transferencia fallan
async function handleTransferFailed(callControlId, callId) {
  try {
    const call = activeCalls.get(callId);
    if (!call) return;
    
    // Limpiar los timeouts
    if (call.transferTimeoutId) {
      clearTimeout(call.transferTimeoutId);
    }
    if (call.messageTimeoutId) {
      clearTimeout(call.messageTimeoutId);
    }
    
    // Marcar la transferencia como fallida
    activeCalls.set(callId, {
      ...call,
      transferEnCurso: false,
      transferFallida: true
    });
    
    logger.info(`❌ Todos los intentos de transferencia fallaron para ${callId}`);
    
    // Mensaje final más claro y detallado
    await telnyxService.speakText(
      callControlId,
      "Lo sentimos, no pudimos contactar a un agente después de varios intentos. Por favor, intente llamar más tarde. Gracias por su paciencia.",
      VOICE_CONFIG.INFO
    );
    
    // Esperar a que termine el mensaje antes de colgar
    await new Promise(resolve => setTimeout(resolve, 10000)); // 10 segundos
    
    // Colgar la llamada
    logger.info(`📞 Colgando llamada ${callId} después de intentos fallidos de transferencia`);
    await telnyxService.hangupCall(callControlId);
  } catch (error) {
    logger.error(`Error al manejar fallo de transferencia: ${error.message}`);
    // Intentar colgar de todas formas
    setTimeout(() => telnyxService.hangupCall(callControlId), 3000);
  }
}

// Función para manejar cuando la transferencia es contestada
function handleTransferAnswered(callControlId, callId, payload) {
  logger.info(`✅ Transferencia contestada para ${callId}`);
  
  const call = activeCalls.get(callId);
  if (!call) return;
  
  // Limpiar timeouts
  if (call.transferTimeoutId) {
    clearTimeout(call.transferTimeoutId);
  }
  if (call.messageTimeoutId) {
    clearTimeout(call.messageTimeoutId);
  }
  
  // Actualizar estado de la llamada
  activeCalls.set(callId, {
    ...call,
    transferEnCurso: false,
    transferExitosa: true
  });
}

async function handleMaxDuration(callControlId, callId) {
  const call = activeCalls.get(callId);
  if (!call) return;
  
  logger.info(`⏰ Duración máxima alcanzada para llamada ${callId}`);
  
  try {
    // Marcar que estamos finalizando por duración máxima
    activeCalls.set(callId, { 
      ...call, 
      finalizandoPorDuracionMaxima: true,
      gatheringDigits: false // Asegurarse de que no esté en estado de gather
    });
    
    // Detener cualquier gather en curso
    try {
      await telnyxService.telnyxApi.post(`/calls/${encodeURIComponent(callControlId)}/actions/gather_stop`, {
        command_id: `stop_gather_${Date.now()}`
      });
      logger.info(`⏹️ Gather detenido para reproducir mensaje de fin de llamada en ${callId}`);
    } catch (gatherError) {
      logger.warn(`⚠️ No se pudo detener gather: ${gatherError.message}`);
      // Continuar aún si falla
    }
    
    // Agregar una pequeña pausa para asegurar que gather se haya detenido
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Mensaje de finalización por duración máxima
    logger.info(`🗣️ Reproduciendo mensaje de fin de llamada para ${callId}`);
    await telnyxService.speakText(
      callControlId,
      "Ha alcanzado el tiempo máximo de llamada permitido de 5 minutos. Gracias por utilizar nuestro servicio.",
      VOICE_CONFIG.INFO
    );
    
    // Esperar a que se complete la reproducción del mensaje (máximo 5 segundos)
    logger.info(`⏱️ Esperando a que se complete el mensaje de fin de llamada para ${callId}`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Detener la supresión de ruido antes de colgar
    try {
      await telnyxService.stopNoiseSuppression(callControlId);
      logger.info(`✅ Supresión de ruido desactivada para llamada ${callId}`);
      
      // Marcar que la supresión ya fue detenida
      const callData = activeCalls.get(callId);
      if (callData) {
        activeCalls.set(callId, { ...callData, suppressionStopped: true });
      }
    } catch (suppressionError) {
      logger.warn(`⚠️ No se pudo desactivar la supresión de ruido: ${suppressionError.message}`);
    }
    
    // Colgar la llamada
    logger.info(`📞 Colgando llamada ${callId} por duración máxima`);
    await telnyxService.hangupCall(callControlId);
    logger.info(`✅ Llamada ${callId} finalizada exitosamente por duración máxima`);
  } catch (error) {
    logger.error(`Error al manejar duración máxima: ${error.message}`);
    // Intentar colgar de todas formas
    setTimeout(() => telnyxService.hangupCall(callControlId), 1000);
  }
}

// Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 Servidor SIP corriendo en puerto ${PORT}`);
});

export default app;//OK