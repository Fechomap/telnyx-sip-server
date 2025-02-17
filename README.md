# Telnyx SIP Server

Sistema IVR (Interactive Voice Response) para consulta de expedientes mediante llamadas telefónicas utilizando la API de Telnyx.

## Características

- Manejo de llamadas SIP entrantes
- Sistema de menús interactivos por voz
- Integración con AWS Polly para Text-to-Speech
- Consulta de expedientes en tiempo real
- Múltiples voces configurables para diferentes contextos
- Sistema de logs detallado

## Requisitos Previos

- Node.js 14.x o superior
- Cuenta activa en Telnyx
- Acceso a la API de expedientes
- Variables de entorno configuradas

## Instalación

1. Clonar el repositorio:
```bash
git clone [url-del-repositorio]
cd telnyx-sip-server
```

2. Instalar dependencias:
```bash
npm install
```

3. Copiar el archivo de variables de entorno:
```bash
cp .env.example .env
```

4. Configurar las variables de entorno en el archivo `.env`

## Estructura del Proyecto

```
├── src/
│   ├── services/
│   │   ├── telnyxService.js    # Servicios de Telnyx
│   │   └── axiosService.js     # Cliente HTTP
│   ├── utils/
│   │   └── helpers.js          # Funciones auxiliares
│   └── server.js               # Punto de entrada
├── .env.example                # Template de variables de entorno
├── package.json
└── README.md
```

## Configuración

El sistema utiliza las siguientes variables de entorno:

- `TELNYX_API_KEY`: Key de API de Telnyx
- `TELNYX_CONNECTION_ID`: ID de conexión SIP de Telnyx
- `API_BASE_URL`: URL base de la API de expedientes
- `PORT`: Puerto para el servidor (default: 3000)

## Voces Disponibles

El sistema soporta diferentes voces de AWS Polly:

- **Mia** (es-MX): Voz femenina estándar
- **Andrés** (es-MX): Voz masculina estándar
- **Mia Neural** (es-MX): Voz femenina neural
- **Andrés Neural** (es-MX): Voz masculina neural

Las voces se pueden configurar en diferentes contextos:
- Bienvenida
- Menús
- Información y respuestas

## Uso

1. Iniciar el servidor en modo desarrollo:
```bash
npm run dev
```

2. Para producción:
```bash
npm start
```

## Flujo de Llamada

1. **Inicio**: 
   - El usuario llama al número asignado
   - Sistema responde con mensaje de bienvenida

2. **Ingreso de Expediente**:
   - Usuario ingresa número de expediente
   - Sistema valida y busca información

3. **Menú Principal**:
   - Para expedientes concluidos:
     - 1: Costos
     - 2: Datos de unidad
     - 3: Tiempos

   - Para expedientes en proceso:
     - 1: Costos
     - 2: Datos de unidad
     - 3: Ubicación
     - 4: Tiempos

## Configuración de Webhook

En el panel de Telnyx, configurar el webhook para apuntar a:
```
https://[tu-dominio]/webhook
```

## Development

Para desarrollo, el sistema incluye:
- Hot reloading con nodemon
- Logging detallado
- Manejo de errores centralizado

## Mantenimiento

Logs de error se guardan en:
- Consola (todos los niveles)
- `error.log` (solo errores)

## Seguridad

- Validación de eventos webhook
- Sanitización de entradas
- Manejo seguro de datos sensibles
- Timeouts configurables

---

# .env.example

```env
# Telnyx Configuration
TELNYX_API_KEY=key_live_xxxxxxxxxxxxxx
TELNYX_CONNECTION_ID=yyyyyyyyyyyyyyy

# API Configuration
API_BASE_URL=https://api.example.com

# Server Configuration
PORT=3000

# Development Settings (optional)
NODE_ENV=development
```

## Variables Explicadas

- `TELNYX_API_KEY`: Tu API key de Telnyx (comienza con 'key_live_' o 'key_test_')
- `TELNYX_CONNECTION_ID`: ID de tu conexión SIP en Telnyx
- `API_BASE_URL`: URL base de tu API de expedientes
- `PORT`: Puerto en el que correrá el servidor
- `NODE_ENV`: Entorno de ejecución (development/production)