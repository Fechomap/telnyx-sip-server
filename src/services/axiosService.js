import axios from 'axios';

// Solo para desarrollo - deshabilita validación de certificados TLS
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

class AxiosService {
  constructor(baseURL) {
    this.api = axios.create({
      baseURL,
      withCredentials: false,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  async request(method, url, data = null, customHeaders = {}, options = {}) {
    const headers = { ...customHeaders };
    const source = axios.CancelToken.source();

    const config = {
      method,
      url,
      headers,
      cancelToken: source.token,
      ...options,
    };

    if (data) {
      config.data = data;
    }

    try {
      const response = await this.api(config);
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  handleError(error) {
    if (error.response) {
      console.error('Error en la respuesta:', error.response.data);
    } else if (error.request) {
      console.error('Error en la solicitud:', error.request);
    } else {
      console.error('Error:', error.message);
    }
    throw error;
  }
}

export default AxiosService;