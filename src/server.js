
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
    voice: "Polly.Mia-Neural",
    language: "es-MX"
  },
  MENU: {
    voice: "Polly.Mia-Neural",
    language: "es-MX"
  },
  INFO: {
    voice: "Polly.Mia-Neural",
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
const TRANSFER_TIMEOUT = 20000; 


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

const transferTracking = new Map();

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


async function transferCallWithRetries(callControlId, callId, destinationNumber, attempt = 1) {
  // Obtener la referencia a la llamada actual
  const call = activeCalls.get(callId);
  if (!call) {
    logger.warn(`⚠️ Llamada ${callId} no encontrada, no se puede transferir`);
    return false;
  }
  
  // Si ya está marcada como exitosa, no hacer nada
  if (call.transferExitosa) {
    logger.info(`ℹ️ La llamada ${callId} ya tiene una transferencia exitosa, ignorando solicitud de reintento`);
    return true;
  }
  
  // Limpiar timeouts anteriores
  if (call.transferTimeoutId) {
    clearTimeout(call.transferTimeoutId);
    logger.info(`🧹 Limpiado timeout anterior para transferencia de ${callId}`);
  }
  
  // Si ya hay una transferencia en progreso con este intento, no iniciar otra
  if (call.transferEnCurso && call.transferIntento === attempt) {
    logger.info(`ℹ️ Transferencia para intento ${attempt} ya en progreso para ${callId}, evitando duplicado`);
    return true;
  }
  
  try {
    // Si no es el primer intento, anunciar que vamos a reintentar
    if (attempt > 1) {
      logger.info(`🗣️ Reproduciendo mensaje de reintento para intento ${attempt}`);
      
      try {
        await telnyxService.speakText(
          callControlId,
          `No pudimos contactar a un agente, intentando nuevamente... (intento ${attempt})`,
          VOICE_CONFIG.INFO
        );
        
        // Esperar a que termine de reproducirse el mensaje
        await new Promise(resolve => setTimeout(resolve, 6000));
        
        logger.info(`✅ Mensaje de reintento reproducido completamente`);
      } catch (messageError) {
        logger.error(`❌ Error al reproducir mensaje de reintento: ${messageError.message}`);
        // Continuar con la transferencia incluso si el mensaje falla
      }
    }
    
    // Registrar el intento actual
    logger.info(`🔄 Intento ${attempt} para transferir llamada ${callId} a ${destinationNumber}`);
    
    // Realizar el intento de transferencia
    await telnyxService.transferCall(callControlId, destinationNumber);
    logger.info(`✅ Solicitud de transferencia enviada para llamada ${callId} (intento ${attempt})`);
    
    // Marcar la llamada como en proceso de transferencia y guardar datos relevantes
    activeCalls.set(callId, {
      ...call,
      transferIntento: attempt,
      transferEnCurso: true,
      transferIniciado: Date.now()
    });

    // Configurar un timeout para verificar si la transferencia tuvo éxito
    const timeoutId = setTimeout(async () => {
      // Verificar nuevamente el estado de la llamada
      const currentCall = activeCalls.get(callId);
      
      // Si la llamada ya no existe, no hacer nada
      if (!currentCall) {
        logger.info(`ℹ️ Llamada ${callId} ya no existe, cancelando verificación`);
        return;
      }
      
      // Si ya está marcada como exitosa, no hacer nada
      if (currentCall.transferExitosa) {
        logger.info(`ℹ️ Transferencia para ${callId} ya fue marcada como exitosa, ignorando timeout`);
        return;
      }
      
      // Si todavía está en transferencia, considerarla como fallida y reintentar
      if (currentCall.transferEnCurso) {
        logger.warn(`⏰ Timeout de transferencia para llamada ${callId} (intento ${attempt})`);
        logger.warn(`⚠️ La transferencia generó un bridge pero no fue contestada`);
        
        // Asegurarse de que no haya otro proceso de reintento en curso
        activeCalls.set(callId, {
          ...currentCall,
          transferEnCurso: false,  // Desmarcar como en curso para evitar duplicados
          transferTimeoutId: null
        });
        
        // Iniciar el siguiente intento (reintentos infinitos)
        logger.info(`🔄 Iniciando intento ${attempt + 1} para ${callId}`);
        // Llamada recursiva con intento incrementado
        await transferCallWithRetries(callControlId, callId, destinationNumber, attempt + 1);
      }
    }, 30000); // 30 segundos es suficiente para detectar si hay respuesta después del bridge
    
    // Guardar referencia al timeout
    activeCalls.set(callId, {
      ...activeCalls.get(callId),
      transferTimeoutId: timeoutId
    });
    
    return true;
  } catch (error) {
    // Error al iniciar la transferencia
    logger.error(`❌ Error en intento ${attempt} de transferencia: ${error.message}`);
    
    // Programar reintento inmediato
    logger.info(`🔄 Pasando al siguiente intento debido a error en API`);
    
    // Marcar explícitamente que no hay transferencia en curso ahora
    activeCalls.set(callId, {
      ...call,
      transferEnCurso: false
    });
    
    // Breve pausa antes del siguiente intento
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Llamada recursiva con intento incrementado
    return transferCallWithRetries(callControlId, callId, destinationNumber, attempt + 1);
  }
}

// Mejora específica para el caso de call.hangup
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
          // Detectar si esta es una llamada transferida
          const isTransferredCall = transferTracking.has(callId);
          
          if (isTransferredCall) {
            // Si es una llamada transferida que termina
            const tracking = transferTracking.get(callId);
            const originalCallId = tracking.originalCallId;
            
            logger.info(`⚠️ Llamada transferida ${callId} finalizó, original: ${originalCallId}, causa: ${payload.hangup_cause}`);
            
            // Buscar la llamada original
            const originalCall = activeCalls.get(originalCallId);
            
            if (originalCall && !originalCall.transferExitosa) {
              // Si la llamada original aún existe y no se ha marcado como transferida exitosamente
              
              // Verificar si el hangup fue por timeout u otra causa que indique fallo
              const failureCauses = ['timeout', 'normal_clearing', 'no_answer', 'busy'];
              
              if (failureCauses.includes(payload.hangup_cause)) {
                logger.warn(`⚠️ Transferencia fallida para ${originalCallId}: ${payload.hangup_cause}`);
                
                // Cancelar cualquier timeout pendiente
                if (originalCall.transferTimeoutId) {
                  clearTimeout(originalCall.transferTimeoutId);
                }
                
                // Programar reintento con un breve retraso
                setTimeout(async () => {
                  try {
                    // Verificar nuevamente el estado de la llamada
                    const latestCall = activeCalls.get(originalCallId);
                    if (!latestCall || latestCall.transferExitosa) {
                      return;
                    }
                    
                    // Informar al usuario
                    await telnyxService.speakText(
                      latestCall.callControlId,
                      "El agente no ha podido contestar. Intentando nuevamente...",
                      VOICE_CONFIG.INFO
                    );
                    
                    // Esperar mensaje y reintentar
                    setTimeout(() => {
                      const nextAttempt = (latestCall.transferIntento || 0) + 1;
                      transferCallWithRetries(
                        latestCall.callControlId,
                        originalCallId,
                        process.env.NUMERO_SOPORTE,
                        nextAttempt
                      );
                    }, 3000);
                  } catch (error) {
                    logger.error(`❌ Error en reintento: ${error.message}`);
                    
                    // Intentar de todas formas
                    setTimeout(() => {
                      const finalCall = activeCalls.get(originalCallId);
                      if (finalCall && !finalCall.transferExitosa) {
                        const nextAttempt = (finalCall.transferIntento || 0) + 1;
                        transferCallWithRetries(
                          finalCall.callControlId,
                          originalCallId,
                          process.env.NUMERO_SOPORTE,
                          nextAttempt
                        );
                      }
                    }, 3000);
                  }
                }, 1000);
              }
            }
            
            // Limpiar el tracking para esta llamada
            transferTracking.delete(callId);
          }
          
          // Procesar hangup normal
          await handleCallHangup(callId, payload);
          break;
        
      case 'call.dtmf.received':
        await handleDtmfReceived(callControlId, callId, payload);
        break;
        
        case 'call.bridged':
          logger.info(`🔄 Llamada ${callId} bridged con destino: ${payload.to || 'desconocido'}`);
          
          // NO marcar como exitosa solo con el bridge
          // Aquí solo registramos que se estableció un puente, pero esperamos call.answered
          // antes de marcar la transferencia como exitosa
          logger.info(`ℹ️ Bridge establecido para ${callId}, esperando contestación...`);
          break;
        
        // En cambio, usamos call.answered para marcar la transferencia como exitosa
        case 'call.answered':
          logger.info(`📞 Llamada ${callId} contestada por ${payload.to || 'desconocido'}`);
          
          // Si es contestada por el número de soporte, marcar como exitosa
          if (payload.to === process.env.NUMERO_SOPORTE || 
              (payload.to && payload.to.includes(process.env.NUMERO_SOPORTE))) {
            
            logger.info(`📞 Número de soporte contestó llamada ${callId}`);
            
            // Buscar todas las llamadas en curso de transferencia
            activeCalls.forEach((call, id) => {
              if (call.transferEnCurso && !call.transferExitosa) {
                logger.info(`✅ Transferencia exitosa detectada para llamada ${id}`);
                
                // Cancelar timeout pendiente
                if (call.transferTimeoutId) {
                  clearTimeout(call.transferTimeoutId);
                }
                
                // Marcar como exitosa
                activeCalls.set(id, {
                  ...call,
                  transferEnCurso: false,
                  transferExitosa: true,
                  transferTimeoutId: null
                });
              }
            });
          }
          break;
        
      default:
        logger.info(`ℹ️ Evento no manejado: ${eventType}`);
    }
  } catch (error) {
    logger.error(`❌ Error manejando evento ${eventType}:`, error);
  }
  
  // Siempre devolver 200 al webhook
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
      // Solo activar supresión si es necesario
      if (process.env.ENABLE_NOISE_SUPPRESSION === 'true') {
        await telnyxService.startNoiseSuppression(callControlId, 'both');
      }
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

// Función mejorada para manejar el fin de mensajes de transferencia
async function handleSpeakEnded(callControlId, callId) {
  const call = activeCalls.get(callId);
  if (!call) return;
  
  // Si ya está marcada como exitosa, no hacer nada
  if (call.transferExitosa) {
    logger.info(`ℹ️ La llamada ${callId} ya tiene una transferencia exitosa, ignorando handleSpeakEnded`);
    return;
  }
  
  try {
    // Verificar si es un mensaje de transferencia INICIAL (no de reintento)
    if (call.transferPending && !call.transferIniciada) {
      logger.info(`🔊 Mensaje de transferencia inicial completado para ${callId}, procediendo con la transferencia`);
      
      // Marcar que ya se inició la transferencia para evitar duplicados
      activeCalls.set(callId, { 
        ...call, 
        transferPending: false,
        transferIniciada: true 
      });
      
      // Pequeña pausa para asegurar que el mensaje se ha reproducido completamente
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Iniciar transferencia con reintentos, comenzando con intento 1
      await transferCallWithRetries(callControlId, callId, process.env.NUMERO_SOPORTE, 1);
      return;
    }
    
    // Si es un mensaje de reintento, ignorarlo (el timeout se encargará)
    if (call.transferIniciada) {
      logger.info(`ℹ️ Ignorando mensaje de reintento en handleSpeakEnded para ${callId}, el timeout manejará el reintento`);
      return;
    }
    
    // Si no es transferencia, seguir con el flujo normal de gather
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
    logger.error(`❌ Error en handleSpeakEnded: ${error.message}`);
    
    // Intentar recuperar la llamada
    try {
      await telnyxService.speakText(
        callControlId,
        "Ocurrió un error. Por favor, intente más tarde.",
        VOICE_CONFIG.INFO
      );
      setTimeout(() => telnyxService.hangupCall(callControlId), 5000);
    } catch (finalError) {
      logger.error(`❌ Error adicional en handleSpeakEnded: ${finalError.message}`);
      setTimeout(() => telnyxService.hangupCall(callControlId), 1000);
    }
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
          // Solo iniciar el proceso de transferencia si no se ha iniciado antes
          if (!call.transferIniciada && !call.transferPending) {
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
            logger.info(`ℹ️ Proceso de transferencia ya iniciado para ${callId}, ignorando solicitud duplicada`);
          }
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

// Función mejorada para manejar fin de llamada
async function handleCallHangup(callId, payload) {
  const call = activeCalls.get(callId);
  if (!call) return;
  
  logger.info(`📞 Llamada ${callId} finalizada: ${payload.hangup_cause || 'motivo desconocido'}`);
  
  try {
    // Limpiar todos los timeouts pendientes
    if (call.transferTimeoutId) clearTimeout(call.transferTimeoutId);
    if (call.messageTimeoutId) clearTimeout(call.messageTimeoutId);
    if (call.maxDurationTimeoutId) clearTimeout(call.maxDurationTimeoutId);
    
    // Si la llamada estaba en proceso de transferencia, registrarlo
    if (call.transferEnCurso && !call.transferExitosa) {
      logger.info(`📊 Llamada ${callId} finalizada durante transferencia (intento ${call.transferIntento || 1})`);
    }
  } catch (error) {
    logger.error(`❌ Error en handleCallHangup: ${error.message}`);
  } finally {
    // Asegurarnos de eliminar la llamada de activeCalls
    activeCalls.delete(callId);
    transferredCalls.delete(callId);
    
    logger.info('📞 Llamada finalizada correctamente');
  }
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

async function handleTransferFailed(callControlId, callId) {
  const call = activeCalls.get(callId);
  if (!call) return;
  
  logger.info(`📞 Se ha decidido finalizar la llamada ${callId} tras varios intentos de transferencia`);
  
  try {
    // Limpiar timeout de transferencia
    if (call.transferTimeoutId) {
      clearTimeout(call.transferTimeoutId);
    }
    
    // Informar al usuario del problema
    await telnyxService.speakText(
      callControlId,
      "No fue posible transferir su llamada después de varios intentos. Por favor, intente más tarde.",
      VOICE_CONFIG.INFO
    );
    
    // Esperar a que termine el mensaje
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Forzar colgado de la llamada
    await telnyxService.hangupCall(callControlId);
    logger.info(`📞 Llamada ${callId} finalizada tras informar al usuario`);
  } catch (error) {
    logger.error(`❌ Error al finalizar llamada ${callId}: ${error.message}`);
    
    // Intentar colgar directamente
    try {
      telnyxService.hangupCall(callControlId);
    } catch (finalError) {
      logger.error(`❌ Error final al intentar colgar ${callId}: ${finalError.message}`);
    }
  } finally {
    // Asegurarnos de eliminar la llamada de activeCalls
    activeCalls.delete(callId);
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

async function realizarIntentoTransferencia(callControlId, callId, destinationNumber, intento) {
  try {
    logger.info(`🚀 Intento ${intento} de transferencia para ${callId}`);
    await telnyxService.transferCall(callControlId, destinationNumber);

    // Timeout de 30 segundos para la transferencia
    const transferExitosa = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 30000);
      
      // Escuchar evento de respuesta
      const handleTransferAnswer = (answeredCallId) => {
        if (answeredCallId === callId) {
          clearTimeout(timeout);
          resolve(true);
          globalEventEmitter.removeListener('call.answered', handleTransferAnswer);
        }
      };
      globalEventEmitter.on('call.answered', handleTransferAnswer);
    });

    return transferExitosa;
  } catch (error) {
    logger.error(`❌ Error en intento ${intento}:`, error);
    return false;
  }
}

// Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 Servidor SIP corriendo en puerto ${PORT}`);
});

export default app;//OK

