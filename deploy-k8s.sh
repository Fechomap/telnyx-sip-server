#!/bin/bash

# Script para desplegar la aplicación Telnyx SIP Server en Kubernetes
# Este script aplica todos los archivos de configuración necesarios en el orden correcto

# Asegúrate de estar conectado al cluster de Kubernetes correcto
echo "🔍 Verificando conexión al cluster Kubernetes..."
kubectl config current-context

# Aplicar secrets primero
echo "🔑 Aplicando secrets..."
if [ -f "secret.yaml" ]; then
  kubectl apply -f secret.yaml
  echo "✅ Secret aplicado correctamente"
else
  echo "❌ Error: Archivo secret.yaml no encontrado"
  echo "El secreto es necesario para el funcionamiento de la aplicación"
  exit 1
fi

# Aplicar configmap si existe
if [ -f "configmap.yaml" ]; then
  echo "⚙️ Aplicando configmap..."
  kubectl apply -f configmap.yaml
  echo "✅ ConfigMap aplicado correctamente"
else
  echo "ℹ️ Nota: configmap.yaml no encontrado, continuando sin ConfigMap"
fi

# Desplegar la aplicación
echo "🚀 Desplegando la aplicación..."
if [ -f "deployment.yaml" ]; then
  kubectl apply -f deployment.yaml
  echo "✅ Deployment aplicado correctamente"
else
  echo "❌ Error: Archivo deployment.yaml no encontrado"
  echo "El deployment es necesario para la aplicación"
  exit 1
fi

# Exponer el servicio
if [ -f "service.yaml" ]; then
  echo "🌐 Exponiendo el servicio..."
  kubectl apply -f service.yaml
  echo "✅ Servicio expuesto correctamente"
else
  echo "❌ Error: Archivo service.yaml no encontrado"
  echo "El servicio es necesario para acceder a la aplicación"
  exit 1
fi

# Aplicar ingress si existe
if [ -f "ingress.yaml" ]; then
  echo "🔄 Aplicando ingress..."
  kubectl apply -f ingress.yaml
  echo "✅ Ingress aplicado correctamente"
fi

# Aplicar HPA (Horizontal Pod Autoscaler) si existe
if [ -f "hpa.yaml" ]; then
  echo "⚖️ Aplicando HPA (Horizontal Pod Autoscaler)..."
  kubectl apply -f hpa.yaml
  echo "✅ HPA aplicado correctamente"
fi

# Verificar el estado del despliegue
echo "🔍 Verificando el estado del despliegue..."
kubectl rollout status deployment/telnyx-sip-server

# Mostrar información de los recursos desplegados
echo -e "\n📊 Pods en ejecución:"
kubectl get pods -l app=telnyx-sip

echo -e "\n🔌 Servicio:"
kubectl get service telnyx-sip-service

# Instrucciones finales
echo -e "\n✅ Despliegue completado exitosamente"
echo "Para verificar los logs en tiempo real, ejecuta:"
echo "kubectl logs -l app=telnyx-sip -f"

# Obtener IP/URL del servicio si es un LoadBalancer
if kubectl get service telnyx-sip-service -o jsonpath='{.spec.type}' | grep -q "LoadBalancer"; then
  echo -e "\n🌐 URL del servicio:"
  echo "Esperando asignación de IP externa..."
  
  # Esperar hasta 60 segundos para obtener la IP externa
  for i in {1..12}; do
    EXTERNAL_IP=$(kubectl get service telnyx-sip-service -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
    if [ -n "$EXTERNAL_IP" ]; then
      echo "http://$EXTERNAL_IP"
      echo "Configura esta dirección en Telnyx para los webhooks"
      break
    fi
    echo -n "."
    sleep 5
  done
  
  if [ -z "$EXTERNAL_IP" ]; then
    echo "No se pudo obtener la IP externa automáticamente."
    echo "Verifica manualmente con: kubectl get service telnyx-sip-service"
  fi
fi