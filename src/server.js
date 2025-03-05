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
  MENU_EN_PROCESO: "Presione 1 para costos, 2 para datos de unidad, 3 para ubicación, 4 para tiempos, 5 para consultar otro expediente"
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
    activeCalls.set(callId, {
      state: 'initiated',
      gatheringDigits: false,
      etapa: 'esperando_expediente',
      intentos: 0
    });

    await delay(DELAYS.ANSWER_CALL);
    await telnyxService.answerCall(callControlId);

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
    activeCalls.set(callId, { ...call, gatheringDigits: true });
    await telnyxService.gatherDigits(
      callControlId,
      null, // Sin instrucción repetida
      "0123456789#",
      10
    );
  } catch (error) {
    logger.error('Error en handleSpeakEnded:', error);
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
        // Incrementar intentos y, si es el segundo fallo, transferir la llamada
        call.intentos++;
        if (call.intentos >= 2) {
          await telnyxService.speakText(
            callControlId,
            "Expediente no encontrado. Transferiremos su llamada.",
            VOICE_CONFIG.INFO
          );
          
          // Transferir a número fijo con formato correcto
          const numeroSoporte = process.env.NUMERO_SOPORTE || "5510112858"; // Obtener del .env si está definido
          
          try {
            await telnyxService.transferCall(callControlId, numeroSoporte);
          } catch (error) {
            logger.error('Error al transferir llamada:', error);
            // Si la transferencia falla, terminar la llamada amablemente
            await telnyxService.speakText(
              callControlId,
              "No fue posible transferir su llamada. Por favor, intente más tarde.",
              VOICE_CONFIG.INFO
            );
            setTimeout(() => telnyxService.hangupCall(callControlId), 3000);
          }
        } else {
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
  activeCalls.delete(callId);
}

// Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 Servidor SIP corriendo en puerto ${PORT}`);
});

export default app;