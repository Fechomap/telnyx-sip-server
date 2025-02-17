import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { createLogger, format, transports } from 'winston';
import TelnyxService from './services/telnyxService.js';
import { delay } from './utils/helpers.js';

// Constantes para delays
const DELAYS = {
  ANSWER_CALL: 2000,
  SPEAK_MESSAGE: 1500,
  MENU_DELAY: 5000
};

// Configuración de voces para diferentes momentos
const VOICE_CONFIG = {
  BIENVENIDA: {
    voice: "Polly.Lucia-Neural",
    language: "es-ES"
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
  MENU_CONCLUIDO: "Presione 1 para costos, 2 para datos de unidad, 3 para tiempos",
  MENU_EN_PROCESO: "Presione 1 para costos, 2 para datos de unidad, 3 para ubicación, 4 para tiempos"
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

async function handleIncomingCall(callControlId, callId, payload) {
  const { from, to } = payload;
  logger.info(`📞 Nueva llamada de ${from} a ${to}`);

  try {
    activeCalls.set(callId, {
      state: 'initiated',
      gatheringDigits: false,
      etapa: 'esperando_expediente'
    });

    await delay(DELAYS.ANSWER_CALL);
    await telnyxService.answerCall(callControlId);

    await delay(DELAYS.SPEAK_MESSAGE);
    // Usar voz de bienvenida
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

async function handleSpeakEnded(callControlId, callId) {
  const call = activeCalls.get(callId);
  if (!call) return;

  try {
    activeCalls.set(callId, { ...call, gatheringDigits: true });

    await telnyxService.gatherDigits(
      callControlId,
      null,  // Sin instrucción repetida
      "0123456789#",
      10
    );
  } catch (error) {
    logger.error('Error en handleSpeakEnded:', error);
    activeCalls.delete(callId);
  }
}

async function handleGatherEnded(callControlId, callId, payload) {
  const call = activeCalls.get(callId);
  if (!call) return;

  const digits = payload.digits;
  logger.info(`📞 Dígitos recibidos: ${digits}`);

  try {
    switch (call.etapa) {
      case 'esperando_expediente': {
        const expedienteData = await telnyxService.obtenerExpediente(digits);
        if (expedienteData) {
          activeCalls.set(callId, {
            ...call,
            etapa: 'menu_principal',
            expediente: digits,
            datosExpediente: expedienteData
          });

          const mensaje = `Expediente encontrado. ${expedienteData.nombre}. ` +
            `Vehículo: ${expedienteData.vehiculo}. ` +
            `Estado: ${expedienteData.estatus}. ` +
            `Servicio: ${expedienteData.servicio}. ` +
            `Destino: ${expedienteData.destino}. `;

          const menuOpciones = expedienteData.estatus === 'Concluido'
            ? MENSAJES.MENU_CONCLUIDO
            : MENSAJES.MENU_EN_PROCESO;

          // Usar voz de información
          await telnyxService.speakText(
            callControlId,
            mensaje,
            VOICE_CONFIG.INFO
          );

          await delay(DELAYS.SPEAK_MESSAGE);

          // Usar voz de menú para presentar opciones
          await telnyxService.gatherDigits(
            callControlId,
            menuOpciones,
            expedienteData.estatus === 'Concluido' ? "123" : "1234",
            1,
            VOICE_CONFIG.MENU
          );
        } else {
          // Usar voz de información para error
          await telnyxService.speakText(
            callControlId,
            MENSAJES.REINGRESO_EXPEDIENTE,
            VOICE_CONFIG.INFO
          );
          await delay(DELAYS.SPEAK_MESSAGE);
          call.etapa = 'esperando_expediente';
          await handleSpeakEnded(callControlId, callId);
        }
        break;
      }
      case 'menu_principal':
        await procesarOpcionMenu(callControlId, callId, digits);
        break;
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

async function procesarOpcionMenu(callControlId, callId, opcion) {
  const call = activeCalls.get(callId);
  if (!call) return;

  try {
    let respuesta = '';
    const expediente = call.expediente;

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
      default:
        respuesta = MENSAJES.OPCION_INVALIDA;
    }

    await telnyxService.speakText(
      callControlId,
      respuesta,
      VOICE_CONFIG.INFO
    );

    // Volver a presentar el menú después de un delay usando voz de menú
    setTimeout(async () => {
      const menuOpciones = call.datosExpediente.estatus === 'Concluido'
        ? MENSAJES.MENU_CONCLUIDO
        : MENSAJES.MENU_EN_PROCESO;
      await telnyxService.gatherDigits(
        callControlId,
        menuOpciones,
        call.datosExpediente.estatus === 'Concluido' ? "123" : "1234",
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

async function handleCallHangup(callId, payload) {
  logger.info('📞 Llamada finalizada:', {
    callId,
    motivo: payload.hangup_cause
  });
  activeCalls.delete(callId);
}

// Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 Servidor SIP corriendo en puerto ${PORT}`);
});

export default app;