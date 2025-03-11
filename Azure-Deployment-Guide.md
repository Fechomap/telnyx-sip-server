# Azure Deployment Guide for Telnyx SIP Server

Esta guía explica cómo desplegar el servicio de telefonía basado en Telnyx en Azure utilizando diferentes opciones, con énfasis en contenedores.

## Índice

- [Prerequisitos](#prerequisitos)
- [Opciones de Despliegue](#opciones-de-despliegue)
- [Opción 1: Kubernetes (Despliegue Actual)](#opción-1-kubernetes-despliegue-actual)
- [Opción 2: Azure Container Apps](#opción-2-azure-container-apps)
- [Opción 3: Azure App Service](#opción-3-azure-app-service)
- [Opción 4: CI/CD con GitHub Actions](#opción-4-cicd-con-github-actions)
- [Opción 5: Infraestructura como Código (Terraform)](#opción-5-infraestructura-como-código-terraform)
- [Configuración de Webhooks en Telnyx](#configuración-de-webhooks-en-telnyx)
- [Monitoreo y Escalado](#monitoreo-y-escalado)
- [Troubleshooting](#troubleshooting)
- [Seguridad](#seguridad)

## Prerequisitos

- Cuenta de Azure con suscripción activa
- Azure CLI instalado y configurado (`az login`)
- Docker instalado en tu máquina local
- Git y repositorio para tu código
- Cuenta de Telnyx con API key y Connection ID
- Acceso a la API de expedientes

## Opciones de Despliegue

Este servicio puede desplegarse de diversas formas. Las principales opciones son:

1. **Kubernetes (Despliegue Actual)**: Actualmente el sistema está desplegado en Kubernetes, proporcionando orquestación robusta de contenedores.
2. **Azure Container Apps**: Servicio serverless para contenedores con escalado automático.
3. **Azure App Service**: Plataforma tradicional como servicio (PaaS) con soporte para contenedores.
4. **Azure Kubernetes Service (AKS)**: Para migrar el despliegue de Kubernetes actual a la nube de Azure.

Esta guía cubre todas estas opciones, comenzando con la implementación actual en Kubernetes.

## Opción 1: Kubernetes (Despliegue Actual)

El sistema actualmente está desplegado en Kubernetes usando los siguientes recursos:

### Preparación de Secretos para Kubernetes

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

### Archivos de Configuración

1. **secret.yaml**: Contiene las credenciales y variables de entorno sensibles codificadas en base64:
   - `TELNYX_API_KEY`
   - `TELNYX_CONNECTION_ID`
   - `TELNYX_FROM_NUMBER`
   - `API_BASE_URL`
   - `NUMERO_SOPORTE`
   - Y otras variables específicas de Telnyx

2. **deployment.yaml**: Define el despliegue con las siguientes características:
   - 2 réplicas para alta disponibilidad
   - Image: `ferchomap/telnyx-sip-server:latest`
   - Recursos limitados (CPU: 300m, Memoria: 256Mi)
   - Health checks (readiness/liveness probes apuntando a `/health`)
   - Variables de entorno tomadas del secret

3. **service.yaml**: Expone el servicio como un LoadBalancer:
   - Puerto 80 externo mapeado al puerto 3000 interno
   - Selector configurado para encontrar los pods con la etiqueta `app: telnyx-sip`

### Despliegue con Script

El despliegue se realiza mediante el script `deploy-k8s.sh` que:
1. Verifica la conexión al cluster correcto
2. Aplica los secretos
3. Aplica configmaps (si existen)
4. Despliega la aplicación y el servicio
5. Opcionalmente aplica ingress y HPA
6. Verifica el estado del despliegue

Para desplegar:
```bash
./deploy-k8s.sh
```

### Verificación del Despliegue

Para verificar el estado del despliegue:
```bash
# Verificar pods
kubectl get pods -l app=telnyx-sip

# Verificar servicio y obtener IP externa
kubectl get service telnyx-sip-service

# Ver logs
kubectl logs -l app=telnyx-sip -f
```

## Opción 2: Azure Container Apps

### 1. Crear Azure Container Registry

Primero, crea un registro de contenedores para almacenar tus imágenes:

```bash
# Crear grupo de recursos
az group create --name telephony-service-rg --location eastus

# Crear registro de contenedores
az acr create --resource-group telephony-service-rg --name telephonyserviceacr --sku Basic --admin-enabled true

# Obtener credenciales
az acr credential show --name telephonyserviceacr
```

### 2. Construir y Publicar la Imagen Docker

```bash
# Iniciar sesión en el registro
az acr login --name telephonyserviceacr

# Construir imagen
docker build -t telephony-service .

# Etiquetar imagen
docker tag telephony-service telephonyserviceacr.azurecr.io/telephony-service:latest

# Publicar imagen
docker push telephonyserviceacr.azurecr.io/telephony-service:latest
```

### 3. Desplegar en Azure Container Apps

```bash
# Crear workspace de Log Analytics
az monitor log-analytics workspace create \
  --resource-group telephony-service-rg \
  --workspace-name telephony-service-workspace

# Obtener ID y clave del workspace
workspace_id=$(az monitor log-analytics workspace show --resource-group telephony-service-rg --workspace-name telephony-service-workspace --query customerId -o tsv)
workspace_key=$(az monitor log-analytics workspace get-shared-keys --resource-group telephony-service-rg --workspace-name telephony-service-workspace --query primarySharedKey -o tsv)

# Crear entorno de Container App
az containerapp env create \
  --name telephony-service-env \
  --resource-group telephony-service-rg \
  --location eastus \
  --logs-workspace-id $workspace_id \
  --logs-workspace-key $workspace_key

# Crear Container App con variables de entorno
az containerapp create \
  --name telephony-service \
  --resource-group telephony-service-rg \
  --environment telephony-service-env \
  --image telephonyserviceacr.azurecr.io/telephony-service:latest \
  --registry-server telephonyserviceacr.azurecr.io \
  --registry-username <username> \
  --registry-password <password> \
  --target-port 3000 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 3 \
  --env-vars \
    "TELNYX_API_KEY=<your-api-key>" \
    "TELNYX_CONNECTION_ID=<your-connection-id>" \
    "TELNYX_FROM_NUMBER=<your-from-number>" \
    "API_BASE_URL=<your-api-base-url>" \
    "NUMERO_SOPORTE=<your-support-number>" \
    "ENABLE_NOISE_SUPPRESSION=true"
```

## Opción 3: Azure App Service

Si prefieres utilizar Azure App Service, sigue estos pasos:

### 1. Crear App Service Plan

```bash
# Crear plan de App Service en Linux
az appservice plan create --name telephony-service-plan --resource-group telephony-service-rg --sku B1 --is-linux
```

### 2. Crear Web App para Contenedores

```bash
# Crear Web App
az webapp create --resource-group telephony-service-rg --plan telephony-service-plan --name your-app-name --deployment-container-image-name telephonyserviceacr.azurecr.io/telephony-service:latest
```

### 3. Configurar Autenticación del Registro

```bash
# Configurar credenciales del registro
az webapp config container set --name your-app-name --resource-group telephony-service-rg --docker-custom-image-name telephonyserviceacr.azurecr.io/telephony-service:latest --docker-registry-server-url https://telephonyserviceacr.azurecr.io --docker-registry-server-user <username> --docker-registry-server-password <password>
```

### 4. Configurar Variables de Entorno

```bash
# Establecer variables de entorno
az webapp config appsettings set --resource-group telephony-service-rg --name your-app-name --settings \
  TELNYX_API_KEY=<your-key> \
  TELNYX_CONNECTION_ID=<your-id> \
  TELNYX_FROM_NUMBER=<your-number> \
  API_BASE_URL=<your-url> \
  NUMERO_SOPORTE=<your-number> \
  WEBSITES_PORT=3000
```

### 5. Activar "Always On"

```bash
# Asegurar que la aplicación siempre esté disponible para recibir webhooks
az webapp config set --resource-group telephony-service-rg --name your-app-name --always-on true
```

## Opción 4: CI/CD con GitHub Actions

Para automatizar el despliegue usando GitHub Actions:

1. Crea los recursos necesarios en Azure como en la Opción 1 o 2
2. Configura el repositorio con un archivo `.github/workflows/azure-deploy.yml`
3. Agrega los siguientes secretos a GitHub:
   - `AZURE_CREDENTIALS` (Credenciales JSON del service principal de Azure)
   - `ACR_LOGIN_SERVER`
   - `ACR_USERNAME`
   - `ACR_PASSWORD`
   - `CONTAINER_APP_NAME`
   - `RESOURCE_GROUP`
   - `TELNYX_API_KEY`
   - `TELNYX_CONNECTION_ID`
   - `TELNYX_FROM_NUMBER`
   - `API_BASE_URL`
   - `NUMERO_SOPORTE`

Un ejemplo de workflow podría ser:

```yaml
name: Build and deploy to Azure Container Apps

on:
  push:
    branches: [ main ]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v2
    
    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v1
    
    - name: Login to ACR
      uses: docker/login-action@v1
      with:
        registry: ${{ secrets.ACR_LOGIN_SERVER }}
        username: ${{ secrets.ACR_USERNAME }}
        password: ${{ secrets.ACR_PASSWORD }}
    
    - name: Build and push
      uses: docker/build-push-action@v2
      with:
        push: true
        tags: ${{ secrets.ACR_LOGIN_SERVER }}/telephony-service:${{ github.sha }}
    
    - name: Login to Azure
      uses: azure/login@v1
      with:
        creds: ${{ secrets.AZURE_CREDENTIALS }}
    
    - name: Deploy to Azure Container Apps
      uses: azure/CLI@v1
      with:
        inlineScript: |
          az containerapp update \
            --name ${{ secrets.CONTAINER_APP_NAME }} \
            --resource-group ${{ secrets.RESOURCE_GROUP }} \
            --image ${{ secrets.ACR_LOGIN_SERVER }}/telephony-service:${{ github.sha }} \
            --set-env-vars \
              "TELNYX_API_KEY=${{ secrets.TELNYX_API_KEY }}" \
              "TELNYX_CONNECTION_ID=${{ secrets.TELNYX_CONNECTION_ID }}" \
              "TELNYX_FROM_NUMBER=${{ secrets.TELNYX_FROM_NUMBER }}" \
              "API_BASE_URL=${{ secrets.API_BASE_URL }}" \
              "NUMERO_SOPORTE=${{ secrets.NUMERO_SOPORTE }}"
```

## Opción 5: Infraestructura como Código (Terraform)

Para desplegar utilizando Terraform:

1. Inicializa Terraform:
   ```bash
   cd infrastructure
   terraform init
   ```

2. Crea un archivo `terraform.tfvars` con tus variables sensibles:
   ```hcl
   resource_group_name = "telephony-service-rg"
   location = "eastus"
   acr_name = "telephonyserviceacr"
   app_name = "telephony-service"
   telnyx_api_key = "your-api-key"
   telnyx_connection_id = "your-connection-id"
   telnyx_from_number = "your-from-number"
   api_base_url = "your-api-base-url"
   numero_soporte = "your-support-number"
   ```

3. Planificar y aplicar:
   ```bash
   terraform plan -out=tfplan
   terraform apply tfplan
   ```

El archivo `main.tf` incluido en este repositorio ya contiene la configuración necesaria para:
- Grupo de recursos
- Container Registry
- Log Analytics Workspace
- Container App Environment
- Container App con todas las variables y configuraciones necesarias

## Configuración de Webhooks en Telnyx

Para que Telnyx envíe eventos a tu servicio:

1. Obtén la URL de tu servicio:
   ```bash
   # Para Kubernetes (despliegue actual)
   kubectl get service telnyx-sip-service -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
   
   # Para Container Apps
   az containerapp show --name telephony-service --resource-group telephony-service-rg --query properties.configuration.ingress.fqdn -o tsv
   
   # Para App Service
   az webapp show --name your-app-name --resource-group telephony-service-rg --query defaultHostName -o tsv
   ```

2. En el portal de Telnyx:
   - Ve a "Messaging" > "Webhooks"
   - Configura la URL del webhook como: `https://<tu-app-url>/webhook`
   - Asegúrate de que HTTPS esté habilitado

3. En la sección de "Call Control" de Telnyx, configura tu Connection ID para que utilice la misma URL de webhook.

## Monitoreo y Escalado

### Monitoreo con Azure Monitor

```bash
# Configurar reglas de alerta
az monitor alert-rule create \
  --name "HighCPUUsage" \
  --resource-group telephony-service-rg \
  --target-resource-type "Microsoft.App/containerApps" \
  --target-resource-name telephony-service \
  --condition "Percentage CPU > 75 for 5 minutes"
```

### Visualización de Logs

```bash
# Ver logs de Container App
az containerapp logs show --name telephony-service --resource-group telephony-service-rg --follow
```

### Verificación de Estado del Contenedor

```bash
# Listar revisiones
az containerapp revision list --name telephony-service --resource-group telephony-service-rg
```

### Ajuste de Configuración de Escalado

```bash
# Actualizar configuración de escalado
az containerapp update \
  --name telephony-service \
  --resource-group telephony-service-rg \
  --min-replicas 2 \
  --max-replicas 5
```

## Troubleshooting

### Problemas Comunes y Soluciones

1. **El webhook no recibe eventos**:
   - Verifica que la URL sea accesible públicamente
   - Asegúrate de que la configuración de Telnyx sea correcta
   - Verifica que `always-on` esté habilitado en App Service

2. **Contenedor no inicia**:
   - Revisa logs: `az containerapp logs show --name telephony-service --resource-group telephony-service-rg`
   - Verifica que todas las variables de entorno estén configuradas
   - Comprueba que la imagen sea accesible desde Azure

3. **Fallas en las llamadas**:
   - Verifica saldo y límites en Telnyx
   - Comprueba la conectividad a la API de expedientes

4. **Error en transferencias de llamadas**:
   - Verifica el formato del número de soporte (debe ser E.164: +523331234567)
   - Comprueba que tengas permiso para realizar llamadas salientes en Telnyx

### Comandos Útiles para Diagnóstico

```bash
# Ver estado de Container App
az containerapp show --name telephony-service --resource-group telephony-service-rg

# Ver configuración actual
az containerapp show --name telephony-service --resource-group telephony-service-rg --query "properties.configuration"

# Ver variables de entorno configuradas
az containerapp show --name telephony-service --resource-group telephony-service-rg --query "properties.template.containers[0].env"
```

## Seguridad

Para mejorar la seguridad del despliegue:

1. **Usar Azure Key Vault para secretos**:
   ```bash
   # Crear Key Vault
   az keyvault create --name telephony-secrets --resource-group telephony-service-rg
   
   # Agregar secretos
   az keyvault secret set --vault-name telephony-secrets --name "telnyx-api-key" --value "your-api-key"
   
   # Configurar identidad administrada
   az containerapp identity assign --name telephony-service --resource-group telephony-service-rg --system-assigned
   
   # Otorgar permisos
   az keyvault set-policy --name telephony-secrets --object-id [identity-principal-id] --secret-permissions get list
   ```

2. **Configurar Private Link**:
   Para acceso seguro a bases de datos o APIs internas.

3. **Restricciones de IP**:
   Limitar el acceso a la aplicación solo desde Telnyx y direcciones confiables.

4. **Habilitar Azure Defender**:
   Para detección avanzada de amenazas.

5. **Actualizar regularmente**:
   Mantener el contenedor y dependencias actualizadas.

## Resumen

Siguiendo esta guía, habrás desplegado el servicio de telefonía basado en Telnyx en Azure utilizando contenedores, proporcionando una solución escalable, confiable y segura para tus necesidades de IVR. La opción recomendada es Azure Container Apps por su facilidad de uso, capacidades de escalado y rentabilidad.