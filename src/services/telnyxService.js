import axios from 'axios';
import AxiosService from './axiosService.js';
import fetch from 'node-fetch';
import Telnyx from 'telnyx';

// Definición de voces disponibles
const VOICES = {
  DEFAULT: {
    voice: "female",
    language: "es-MX"
  },
  POLLY: {
    MIA: {
      voice: "Polly.Mia",
      language: "es-MX"
    },
    ANDRES: {
      voice: "Polly.Andres",
      language: "es-MX"
    },
    MIA_NEURAL: {
      voice: "Polly.Mia-Neural",
      language: "es-MX"
    },
    ANDRES_NEURAL: {
      voice: "Polly.Andres-Neural",
      language: "es-MX"
    }
  }
};

class TelnyxService {
  constructor() {
    // Configuración de Telnyx
    this.apiKey = process.env.TELNYX_API_KEY;
    this.connectionId = process.env.TELNYX_CONNECTION_ID;
    
    // Cliente para API de Telnyx
    this.telnyxApi = axios.create({
      baseURL: 'https://api.telnyx.com/v2',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    // Cliente para API de expedientes
    this.apiService = new AxiosService(process.env.API_BASE_URL);

    // Inicialización del caché en memoria
    // (En producción podrías usar una librería como node-cache o Redis para mayor robustez)
    this.cache = new Map();
  }

  async speakText(callControlId, text, voiceConfig = VOICES.POLLY.MIA_NEURAL) {
    const encodedId = encodeURIComponent(callControlId);
    try {
      await this.telnyxApi.post(`/calls/${encodedId}/actions/speak`, {
        payload: text,
        voice: voiceConfig.voice,
        language: voiceConfig.language,
        command_id: `speak_${Date.now()}`,
        // Habilitar interrupciones DTMF
        stop_speaking_on_digit: true  // Esto permite que cualquier dígito detenga el mensaje
      });
    } catch (error) {
      console.error('Error al hablar:', error.message);
      throw error;
    }
  }

  async gatherDigits(callControlId, prompt, validDigits, maxDigits, voiceConfig = VOICES.POLLY.MIA_NEURAL) {
    const encodedId = encodeURIComponent(callControlId);
    try {
      await this.telnyxApi.post(`/calls/${encodedId}/actions/gather_using_speak`, {
        payload: prompt || "\u200B",  // Mensaje corto y neutral si no hay prompt
        voice: voiceConfig.voice,
        language: voiceConfig.language,
        valid_digits: validDigits,
        max_digits: maxDigits,
        inter_digit_timeout: 5,
        client_state: Buffer.from('gather').toString('base64'),
        command_id: `gather_${Date.now()}`
      });
    } catch (error) {
      console.error('Error en gatherDigits:', error.message);
      throw error;
    }
  }

  async answerCall(callControlId) {
    const encodedId = encodeURIComponent(callControlId);
    try {
      await this.telnyxApi.post(`/calls/${encodedId}/actions/answer`);
      return true;
    } catch (error) {
      console.error('Error al contestar:', error.message);
      throw error;
    }
  }

  async hangupCall(callControlId) {
    const encodedId = encodeURIComponent(callControlId);
    try {
      await this.telnyxApi.post(`/calls/${encodedId}/actions/hangup`, {
        command_id: `hangup_${Date.now()}`
      });
    } catch (error) {
      console.error('Error al colgar:', error.message);
      throw error;
    }
  }

  // Función genérica para obtener datos desde un endpoint y cachearlos
  async obtenerDataFromEndpoint(cacheKey, endpoint) {
    // Si ya existe en caché, retornar inmediatamente
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }
    try {
      const response = await this.apiService.request('GET', endpoint);
      const data = response.dataResponse;
      // Almacenar en caché el resultado
      this.cache.set(cacheKey, data);
      return data;
    } catch (error) {
      console.error(`Error al obtener datos para ${cacheKey}:`, error);
      return null;
    }
  }

  // Modificaciones al método transferCall en telnyxService.js

  async transferCall(callControlId, destinationNumber) {
    const encodedId = encodeURIComponent(callControlId);
    try {
      // Formatear el número en formato E.164 si no comienza con "+"
      let formattedNumber = destinationNumber;
      if (!destinationNumber.startsWith('+')) {
        // Si el número no comienza con 52 (prefijo de México), agregarlo
        if (!destinationNumber.startsWith('52')) {
          formattedNumber = `+52${destinationNumber}`;
        } else {
          formattedNumber = `+${destinationNumber}`;
        }
      }
      
      console.log(`🔄 Intentando transferir llamada ${callControlId} a ${formattedNumber}`);
    
      // Usar la API REST de Telnyx con el cliente axios
      const response = await this.telnyxApi.post(`/calls/${encodedId}/actions/transfer`, {
        to: formattedNumber,
        from: process.env.TELNYX_FROM_NUMBER,
        command_id: `transfer_${Date.now()}`
      });
    
      console.log(`✅ Transferencia exitosa: ${JSON.stringify(response.data)}`);
      return response.data;
    } catch (error) {
      // Manejar errores específicos de la API
      let errorMessage = 'Error desconocido';
      
      if (error.response) {
        // Error con respuesta del servidor
        errorMessage = `Error de Telnyx (${error.response.status}): ${JSON.stringify(error.response.data)}`;
        
        // Manejar códigos de error específicos
        if (error.response.status === 422) {
          errorMessage = `La llamada no se puede transferir porque ya está en otro estado`;
        } else if (error.response.status === 401 || error.response.status === 403) {
          errorMessage = `Error de autenticación con la API de Telnyx`;
        }
      } else if (error.request) {
        // Error de conexión
        errorMessage = `No se pudo conectar con la API de Telnyx: ${error.message}`;
      } else {
        errorMessage = `Error en la creación de la solicitud: ${error.message}`;
      }
      
      console.error(`🚨 TransferCall falló: ${errorMessage}`);
      throw new Error(`TransferCall falló: ${errorMessage}`);
    }
  }
  
  async obtenerExpediente(numeroExp) {
    const cacheKey = `expediente-${numeroExp}`;
    const endpoint = `/api/ConsultaExterna/ObtenerExpedienteBot?numero=${numeroExp}`;
    return await this.obtenerDataFromEndpoint(cacheKey, endpoint);
  }

  async obtenerExpedienteCosto(numeroExp) {
    const cacheKey = `expediente-costo-${numeroExp}`;
    const endpoint = `/api/ConsultaExterna/ObtenerExpedienteCostoBot?numero=${numeroExp}`;
    return await this.obtenerDataFromEndpoint(cacheKey, endpoint);
  }

  async obtenerExpedienteUnidadOp(numeroExp) {
    const cacheKey = `expediente-unidad-${numeroExp}`;
    const endpoint = `/api/ConsultaExterna/ObtenerExpedienteUnidadOpBot?numero=${numeroExp}`;
    return await this.obtenerDataFromEndpoint(cacheKey, endpoint);
  }

  async obtenerExpedienteUbicacion(numeroExp) {
    const cacheKey = `expediente-ubicacion-${numeroExp}`;
    const endpoint = `/api/ConsultaExterna/ObtenerExpedienteUbicacionBot?numero=${numeroExp}`;
    return await this.obtenerDataFromEndpoint(cacheKey, endpoint);
  }

  async obtenerExpedienteTiempos(numeroExp) {
    const cacheKey = `expediente-tiempos-${numeroExp}`;
    const endpoint = `/api/ConsultaExterna/ObtenerExpedienteTiemposBot?numero=${numeroExp}`;
    return await this.obtenerDataFromEndpoint(cacheKey, endpoint);
  }
}

export default TelnyxService;