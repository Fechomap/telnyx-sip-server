import axios from 'axios';
import AxiosService from './axiosService.js';

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
  }

  async speakText(callControlId, text, voiceConfig = VOICES.POLLY.MIA_NEURAL) {
    const encodedId = encodeURIComponent(callControlId);
    try {
      await this.telnyxApi.post(`/calls/${encodedId}/actions/speak`, {
        payload: text,
        voice: voiceConfig.voice,
        language: voiceConfig.language,
        command_id: `speak_${Date.now()}`
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

  // ... resto de los métodos permanecen iguales ...
  
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

  async obtenerExpediente(numeroExp) {
    try {
      const response = await this.apiService.request(
        'GET',
        `/api/ConsultaExterna/ObtenerExpedienteBot?numero=${numeroExp}`
      );
      return response.dataResponse;
    } catch (error) {
      console.error('Error al obtener expediente:', error);
      return null;
    }
  }

  async obtenerExpedienteCosto(numeroExp) {
    try {
      const response = await this.apiService.request(
        'GET',
        `/api/ConsultaExterna/ObtenerExpedienteCostoBot?numero=${numeroExp}`
      );
      return response.dataResponse;
    } catch (error) {
      console.error('Error al obtener costo:', error);
      return null;
    }
  }

  async obtenerExpedienteUnidadOp(numeroExp) {
    try {
      const response = await this.apiService.request(
        'GET',
        `/api/ConsultaExterna/ObtenerExpedienteUnidadOpBot?numero=${numeroExp}`
      );
      return response.dataResponse;
    } catch (error) {
      console.error('Error al obtener unidad:', error);
      return null;
    }
  }

  async obtenerExpedienteUbicacion(numeroExp) {
    try {
      const response = await this.apiService.request(
        'GET',
        `/api/ConsultaExterna/ObtenerExpedienteUbicacionBot?numero=${numeroExp}`
      );
      return response.dataResponse;
    } catch (error) {
      console.error('Error al obtener ubicación:', error);
      return null;
    }
  }

  async obtenerExpedienteTiempos(numeroExp) {
    try {
      const response = await this.apiService.request(
        'GET',
        `/api/ConsultaExterna/ObtenerExpedienteTiemposBot?numero=${numeroExp}`
      );
      return response.dataResponse;
    } catch (error) {
      console.error('Error al obtener tiempos:', error);
      return null;
    }
  }
}

export default TelnyxService;