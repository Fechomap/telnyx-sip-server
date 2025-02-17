/**
 * Función para crear delays/retrasos en la ejecución
 * @param {number} ms - Milisegundos a esperar
 * @returns {Promise} Promise que se resuelve después del tiempo especificado
 */
export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Divide un texto largo en fragmentos más pequeños
 * @param {string} text - Texto a dividir
 * @param {number} maxLength - Longitud máxima de cada fragmento
 * @returns {string[]} Array de fragmentos de texto
 */
export const splitText = (text, maxLength = 150) => {
  const words = text.split(" ");
  const chunks = [];
  let current = "";
  
  for (let word of words) {
    if ((current + word).length > maxLength) {
      chunks.push(current.trim());
      current = word + " ";
    } else {
      current += word + " ";
    }
  }
  
  if (current) {
    chunks.push(current.trim());
  }
  
  return chunks;
};