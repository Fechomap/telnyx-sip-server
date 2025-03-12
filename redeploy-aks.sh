#!/bin/bash

# Script para eliminar y volver a desplegar recursos en Azure
# Este script elimina todos los recursos existentes y luego redespliega desde cero

# Colores para mejorar la legibilidad
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuración
RESOURCE_GROUP="telephony-service-rg"
AKS_CLUSTER_NAME="telephony-cluster"
ACR_NAME="telephonyserviceacr"
LOCATION="eastus"

echo -e "${BLUE}=== Script de Limpieza y Redespliegue de Recursos Azure ===${NC}"

# Función para verificar si el comando se ejecutó correctamente
check_status() {
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Éxito: $1${NC}"
    else
        echo -e "${RED}✗ Error: $1${NC}"
        echo "Deteniendo el script..."
        exit 1
    fi
}

# 1. Confirmar antes de proceder
echo -e "${YELLOW}ADVERTENCIA: Este script eliminará todos los recursos en el grupo ${RESOURCE_GROUP}${NC}"
echo -e "${YELLOW}Esto incluye el cluster AKS, ACR y todos los servicios relacionados.${NC}"
read -p "¿Estás seguro de que deseas continuar? (s/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Ss]$ ]]; then
    echo -e "${BLUE}Operación cancelada por el usuario.${NC}"
    exit 0
fi

# 2. Verificar si el usuario está conectado a Azure
echo -e "\n${BLUE}Verificando conexión a Azure...${NC}"
az account show &> /dev/null
if [ $? -ne 0 ]; then
    echo -e "${YELLOW}No estás conectado a Azure. Iniciando sesión...${NC}"
    az login
    check_status "Inicio de sesión en Azure"
else
    echo -e "${GREEN}✓ Ya estás conectado a Azure${NC}"
fi

# 3. Eliminar el grupo de recursos existente
echo -e "\n${BLUE}Eliminando el grupo de recursos ${RESOURCE_GROUP}...${NC}"
echo -e "${YELLOW}Este proceso puede tardar varios minutos.${NC}"
az group delete --name ${RESOURCE_GROUP} --yes --no-wait
echo -e "${GREEN}✓ Solicitud de eliminación enviada. Esperando que se complete...${NC}"

# 4. Esperar hasta que el grupo de recursos se elimine completamente
echo -e "\n${BLUE}Esperando a que se complete la eliminación...${NC}"
while az group show --name ${RESOURCE_GROUP} &> /dev/null; do
    echo -e "${YELLOW}El grupo de recursos todavía existe. Esperando 30 segundos...${NC}"
    sleep 30
done
echo -e "${GREEN}✓ Grupo de recursos eliminado correctamente${NC}"

# 5. Crear un nuevo grupo de recursos
echo -e "\n${BLUE}Creando un nuevo grupo de recursos...${NC}"
az group create --name ${RESOURCE_GROUP} --location ${LOCATION}
check_status "Creación del grupo de recursos"

# 6. Crear Azure Container Registry (ACR)
echo -e "\n${BLUE}Creando Azure Container Registry...${NC}"
az acr create --resource-group ${RESOURCE_GROUP} --name ${ACR_NAME} --sku Basic --admin-enabled true
check_status "Creación de ACR"

# 7. Crear un espacio de trabajo de Log Analytics
echo -e "\n${BLUE}Creando espacio de trabajo Log Analytics...${NC}"
az monitor log-analytics workspace create \
  --resource-group ${RESOURCE_GROUP} \
  --workspace-name "${AKS_CLUSTER_NAME}-workspace"
check_status "Creación de Log Analytics workspace"

# 8. Obtener ID y clave del workspace
echo -e "\n${BLUE}Obteniendo credenciales del workspace...${NC}"
WORKSPACE_ID=$(az monitor log-analytics workspace show --resource-group ${RESOURCE_GROUP} --workspace-name "${AKS_CLUSTER_NAME}-workspace" --query customerId -o tsv)
WORKSPACE_KEY=$(az monitor log-analytics workspace get-shared-keys --resource-group ${RESOURCE_GROUP} --workspace-name "${AKS_CLUSTER_NAME}-workspace" --query primarySharedKey -o tsv)
check_status "Obtención de credenciales de Log Analytics"

# 9. Crear cluster AKS
echo -e "\n${BLUE}Creando cluster AKS...${NC}"
echo -e "${YELLOW}Este proceso puede tardar varios minutos.${NC}"
az aks create \
  --resource-group ${RESOURCE_GROUP} \
  --name ${AKS_CLUSTER_NAME} \
  --node-count 2 \
  --enable-addons monitoring \
  --workspace-resource-id $(az monitor log-analytics workspace show --resource-group ${RESOURCE_GROUP} --workspace-name "${AKS_CLUSTER_NAME}-workspace" --query id -o tsv) \
  --enable-managed-identity \
  --generate-ssh-keys \
  --attach-acr ${ACR_NAME}
check_status "Creación de cluster AKS"

# 10. Obtener credenciales para kubectl
echo -e "\n${BLUE}Configurando kubectl...${NC}"
az aks get-credentials --resource-group ${RESOURCE_GROUP} --name ${AKS_CLUSTER_NAME} --overwrite-existing
check_status "Configuración de kubectl"

# 11. Construir y publicar la imagen Docker
echo -e "\n${BLUE}Construyendo y publicando la imagen Docker en ACR...${NC}"
# Iniciar sesión en ACR
az acr login --name ${ACR_NAME}
check_status "Inicio de sesión en ACR"

# Construir la imagen
docker build -t telnyx-sip-server .
check_status "Construcción de imagen Docker"

# Etiquetar la imagen
docker tag telnyx-sip-server ${ACR_NAME}.azurecr.io/telnyx-sip-server:latest
check_status "Etiquetado de imagen Docker"

# Publicar la imagen
docker push ${ACR_NAME}.azurecr.io/telnyx-sip-server:latest
check_status "Publicación de imagen Docker en ACR"

# 12. Aplicar configuraciones de Kubernetes
echo -e "\n${BLUE}Aplicando configuraciones de Kubernetes...${NC}"
# Aplicar secret.yaml primero
kubectl apply -f secret.yaml
check_status "Aplicación de secret.yaml"

# Aplicar deployment.yaml
kubectl apply -f deployment.yaml
check_status "Aplicación de deployment.yaml"

# Aplicar service.yaml
kubectl apply -f service.yaml
check_status "Aplicación de service.yaml"

# 13. Verificar que todo esté funcionando
echo -e "\n${BLUE}Verificando el estado del despliegue...${NC}"
kubectl get all
check_status "Visualización de recursos Kubernetes"

# 14. Obtener la IP pública del servicio
echo -e "\n${BLUE}Esperando a que el servicio obtenga una IP pública...${NC}"
EXTERNAL_IP=""
while [ -z $EXTERNAL_IP ]; do
  echo -e "${YELLOW}Esperando IP externa...${NC}"
  EXTERNAL_IP=$(kubectl get service telnyx-sip-service --output jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)
  if [ -z $EXTERNAL_IP ]; then
    sleep 10
  fi
done
echo -e "${GREEN}✓ IP externa obtenida: ${EXTERNAL_IP}${NC}"

# 15. Mostrar información de finalización
echo -e "\n${GREEN}=== ¡Despliegue Completado! ===${NC}"
echo -e "${GREEN}Tu aplicación Telnyx SIP Server ha sido desplegada exitosamente.${NC}"
echo -e "${BLUE}URL de la aplicación: http://${EXTERNAL_IP}${NC}"
echo -e "${BLUE}Para actualizar la URL del webhook en Telnyx, usa: http://${EXTERNAL_IP}/webhook${NC}"
echo 
echo -e "${YELLOW}Recuerda configurar la URL del webhook en el portal de Telnyx.${NC}"
echo -e "${YELLOW}Para monitorear los logs: kubectl logs -l app=telnyx-sip -f${NC}"
echo -e "${YELLOW}Para acceder al dashboard: az aks browse --resource-group ${RESOURCE_GROUP} --name ${AKS_CLUSTER_NAME}${NC}"