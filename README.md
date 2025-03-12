# Telnyx SIP Server

Sistema IVR (Interactive Voice Response) para consulta de expedientes mediante llamadas telefónicas utilizando la API de Telnyx.

## Características

- Manejo de llamadas SIP entrantes
- Sistema de menús interactivos por voz
- Integración con AWS Polly para Text-to-Speech de alta calidad
- Consulta de expedientes en tiempo real
- Múltiples voces configurables para diferentes contextos
- Sistema de logs detallado
- Transferencia automática a operadores humanos cuando es necesario
- Soporte para barge-in (interrupciones DTMF)
- Supresión de ruido para mejorar la calidad de llamadas

## Requisitos Previos

- Node.js 18.x o superior
- Cuenta activa en Telnyx
- Acceso a la API de expedientes
- Variables de entorno configuradas
- Docker (opcional, para despliegue con contenedores)
- Kubernetes (opcional, para despliegue en cluster)

## Instalación

### Desarrollo Local

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

4. Configurar las variables de entorno en el archivo `.env` con tus credenciales de Telnyx

5. Iniciar el servidor en modo desarrollo:
```bash
npm run dev
```

### Usando Docker

1. Construir la imagen:
```bash
docker build -t telnyx-sip-server .
```

2. Ejecutar el contenedor:
```bash
docker run -p 3000:3000 \
  -e TELNYX_API_KEY=your_api_key \
  -e TELNYX_CONNECTION_ID=your_connection_id \
  -e TELNYX_FROM_NUMBER=your_from_number \
  -e API_BASE_URL=your_api_base_url \
  -e NUMERO_SOPORTE=your_support_number \
  telnyx-sip-server
```

### Usando Docker Compose

1. Configurar variables de entorno en un archivo `.env`

2. Ejecutar:
```bash
docker-compose up -d
```

### Despliegue en Kubernetes (Producción)

#### Preparación de Secretos para Kubernetes

Para el despliegue en Kubernetes, los secretos deben estar codificados en base64. Hemos proporcionado un archivo `secret.yaml.example` como referencia.

Pasos para crear tu archivo `secret.yaml`:

1. Copia el archivo de ejemplo:
   ```bash
   cp secret.yaml.example secret.yaml
   ```

2. Codifica tus valores en base64:
   ```bash
   # En sistemas Unix (Linux/Mac)
   echo -n "tu-valor-secreto" | base64

   # En Windows (PowerShell)
   [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("tu-valor-secreto"))
   ```

3. Reemplaza los valores de ejemplo en `secret.yaml` con tus valores codificados

4. Aplica los secretos a tu cluster:
   ```bash
   kubectl apply -f secret.yaml
   ```

**Importante**: Nunca subas el archivo `secret.yaml` con tus credenciales reales a un repositorio de código. Asegúrate de que esté incluido en tu `.gitignore`.

#### Archivos de Configuración y Despliegue

1. Configurar los archivos Kubernetes en la raíz del proyecto:
   - `secret.yaml`: Contiene las variables de entorno cifradas en base64
   - `deployment.yaml`: Configura el despliegue con réplicas, recursos, y health checks
   - `service.yaml`: Expone el servicio como LoadBalancer

2. Ejecutar el script de despliegue:
```bash
./deploy-k8s.sh
```

Este script aplica todos los archivos Kubernetes en el orden correcto y verifica el estado del despliegue.

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
├── .env                        # Variables de entorno (no incluido en repo)
├── deployment.yaml             # Configuración de despliegue K8s
├── service.yaml                # Configuración de servicio K8s
├── secret.yaml                 # Secretos para K8s (no incluir en repo)
├── deploy-k8s.sh               # Script de despliegue para K8s
├── Dockerfile                  # Configuración para crear imagen Docker
├── docker-compose.yml          # Configuración para Docker Compose
├── package.json                # Dependencias y scripts
└── README.md                   # Este archivo
```

## Configuración

El sistema utiliza las siguientes variables de entorno:

| Variable | Descripción | Obligatorio |
|----------|-------------|-------------|
| `TELNYX_API_KEY` | Key de API de Telnyx | Sí |
| `TELNYX_CONNECTION_ID` | ID de conexión SIP de Telnyx | Sí |
| `TELNYX_FROM_NUMBER` | Número telefónico de origen para transferencias | Sí |
| `API_BASE_URL` | URL base de la API de expedientes | Sí |
| `NUMERO_SOPORTE` | Número telefónico para transferencias a soporte | Sí |
| `PORT` | Puerto para el servidor (default: 3000) | No |
| `NODE_ENV` | Entorno de ejecución (development/production) | No |
| `ENABLE_NOISE_SUPPRESSION` | Activar supresión de ruido (true/false) | No |
| `ENABLE_PROGRESSIVE_TRANSFER_RETRY` | Activa reintentos en transferencias | No |
| `ENABLE_BRIDGE_DETECTION` | Activa la detección de bridge | No |

## Voces Disponibles

El sistema soporta diferentes voces de AWS Polly:

- **Mia** (es-MX): Voz femenina estándar
- **Andrés** (es-MX): Voz masculina estándar
- **Mia Neural** (es-MX): Voz femenina neural (recomendada)
- **Andrés Neural** (es-MX): Voz masculina neural

Las voces se configuran en `server.js` para diferentes contextos:
- Bienvenida (`VOICE_CONFIG.BIENVENIDA`)
- Menús (`VOICE_CONFIG.MENU`)
- Información y respuestas (`VOICE_CONFIG.INFO`)

## Flujo de Llamada

1. **Inicio**: 
   - El usuario llama al número asignado
   - Sistema responde con mensaje de bienvenida

2. **Ingreso de Expediente**:
   - Usuario ingresa número de expediente
   - Sistema valida y busca información
   - Si el expediente no se encuentra después de 2 intentos, la llamada se transfiere a un operador

3. **Menú Principal**:
   - Para expedientes concluidos:
     - 1: Costos
     - 2: Datos de unidad
     - 3: Tiempos
     - 5: Consultar otro expediente

   - Para expedientes en proceso:
     - 1: Costos
     - 2: Datos de unidad
     - 3: Ubicación
     - 4: Tiempos
     - 5: Consultar otro expediente

4. **Límites**:
   - Máximo 10 expedientes por llamada
   - Máximo 2 consultas por expediente
   - Duración máxima de llamada: 5 minutos

## Configuración de Webhook en Telnyx

1. En el panel de Telnyx, ir a "Messaging" > "Webhooks"
2. Configurar el webhook para apuntar a:
```
https://[tu-dominio]/webhook
```
3. Asegurarse de activar la verificación HTTPS

## Troubleshooting

### Problemas Comunes

1. **Webhook no recibe eventos**:
   - Verificar URL y accesibilidad pública
   - Comprobar certificado HTTPS
   - Revisar logs en Telnyx Portal

2. **Errores de transferencia**:
   - Verificar formato del número de soporte (formato E.164)
   - Comprobar saldo en cuenta Telnyx
   - Verificar permisos de llamada saliente

3. **La aplicación no inicia**:
   - Verificar todas las variables de entorno
   - Comprobar conectividad a API de expedientes
   - Revisar logs de aplicación

### Logs

Los logs se guardan en:
- Consola (todos los niveles)
- `error.log` (solo errores)

## Seguridad

- Validación de eventos webhook
- Sanitización de entradas
- Manejo seguro de datos sensibles
- Timeouts configurables
- Supresión de ruido para mejorar la privacidad

## Mantenimiento

Es recomendable mantener actualizado:
- Dependencias de Node.js (npm audit)
- Imagen base de Docker
- SDK de Telnyx
