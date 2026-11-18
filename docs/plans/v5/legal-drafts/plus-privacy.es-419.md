# Suplemento de Privacidad de Levix Plus

Este documento describe las prácticas de procesamiento de datos para la suscripción opcional **Levix Plus** en las compilaciones de Levix para Android.

---

## 1. Resumen y finalidades

Levix Plus es una suscripción de pago y opcional. El servicio de verificación operado por Leviro en `https://levix-plus.leviro.net` recopila y procesa metadatos limitados de suscripción e instalación exclusivamente para las siguientes finalidades:
- Verificar las compras y el estado activo de la suscripción con Google Play.
- Aplicar la política de instalación de la suscripción (una sola instalación activa a la vez, hasta tres transferencias de instalación en cualquier período móvil de 30 días).
- Prevenir el fraude y el abuso.

Levix Plus **no contiene publicidad**, no realiza seguimiento a través de aplicaciones de terceros y **no vende datos de usuarios**.

---

## 2. Datos que salen del dispositivo

Cuando usted decide comprar, restaurar o verificar Levix Plus, o cuando la aplicación actualiza automáticamente la autorización de la suscripción, la aplicación envía una solicitud directa a `https://levix-plus.leviro.net`.

La solicitud contiene:
- El token de compra de Google Play (purchase token).
- El nombre del paquete de Android y el identificador del producto.
- Un identificador de instalación seudónimo (un hash SHA-256 de una clave pública de instalación generada en el dispositivo).
- La propia clave pública de la instalación (Ed25519).
- Un nonce de solicitud.
- La marca de tiempo (timestamp) del cliente.
- Un número secuencial monotónico de solicitud.
- Una firma criptográfica Ed25519 generada sobre el contenido de la solicitud utilizando la clave privada de instalación del dispositivo.

**Lo que nunca se envía:** Levix Plus nunca transmite mensajes de WhatsApp, contenido de chats, identificadores de participantes, contactos o números de teléfono al servicio de verificación.

---

## 3. Procesamiento por Google Play y notificaciones en tiempo real

- Google Play procesa las compras, renovaciones, cancelaciones y reembolsos de la suscripción conforme a los términos y políticas de privacidad aplicables de Google.
- El servicio de verificación consulta la API para desarrolladores de Google Play (Developer API) para confirmar el estado de compra de la suscripción, las fechas de vencimiento y el estado de confirmación (acknowledgement).
- El servicio de verificación recibe Notificaciones en tiempo real para programadores (RTDN) autenticadas de Google Play a través de Google Cloud Pub/Sub para gestionar renovaciones, cancelaciones, períodos de gracia y reembolsos de suscripciones.

---

## 4. Datos almacenados por el servicio de verificación

El servicio de verificación almacena los siguientes registros:
- Un hash SHA-256 del token de compra y el propio token de compra cifrado en reposo con AES-256-GCM mediante una clave de servicio.
- Metadados de la suscripción: nombre del paquete, identificador del producto, estado de la suscripción en Google Play, marca de tiempo de vencimiento, estado de confirmación, indicador de compra de prueba y marcas de tiempo de vinculación inicial y verificaciones.
- Registros de vinculación de la instalación: clave pública de la instalación, contador de secuencia y marcas de tiempo de registro y actualización.
- Historial de transferencias de instalación: marcas de tiempo e identificadores de instalación asociados con transferencias entre dispositivos.
- Identificadores de mensajes de notificación de Google Cloud Pub/Sub.

---

## 5. Períodos de retención y medidas de registro (logs)

- **Nonces de solicitud:** Se conservan durante 10 minutos para evitar ataques de repetición y luego se eliminan automáticamente.
- **Identificadores de mensajes de Pub/Sub:** Se conservan durante 7 días para evitar el procesamiento duplicado de notificaciones de Google Play y luego se eliminan.
- **Compras e historial de transferencias:** Se eliminan 90 días después del vencimiento de la suscripción en Google Play.
- **Registros de instalación:** Se conservan mientras el servicio de verificación esté en funcionamiento.
- **Copias de seguridad del servidor:** Siguen el cronograma estándar de retención de copias de seguridad del operador del servicio.
- **Medidas de registro:** El servicio de verificación nunca registra en logs tokens de compra, firmas de solicitud, claves privadas ni cuerpos sin procesar de las solicitudes. Las direcciones IP se utilizan únicamente para la limitación transitoria de frecuencia (rate limiting) en memoria.

---

## 6. Datos almacenados localmente en el dispositivo

- La clave privada de la instalación y el token de autorización firmado digitalmente devuelto por el servicio de verificación se almacenan sellados (cifrados con AES-256-GCM) en la base de datos local de Levix.
- La clave privada de la instalación y el token de autorización firmado **nunca** se incluyen en exportaciones de ajustes, copias de seguridad de la base de datos previas a la migración ni copias de seguridad exportadas por el usuario, y **nunca** se cargan en ningún servidor (solo la clave pública correspondiente se envía al servicio de verificación).

---

## 7. Copias de seguridad y restauración

- Las copias de seguridad locales cifradas de Levix (creadas mediante Ajustes > Copia de seguridad con una contraseña del operador) pueden incluir personalizaciones de Plus: mensajes personalizados del bot y sus traducciones, preajustes, preferencias de visibilidad y reglas de Respuesta Automática (incluidas las configuraciones de memoria global por chat).
- Restaurar una copia de seguridad **nunca** activa Levix Plus; el estado de la autorización siempre se vuelve a verificar por separado con el servicio de verificación.
- Las reglas de Respuesta Automática se restauran únicamente cuando se vincula la misma cuenta de WhatsApp.

---

## 8. Funciones de Respuesta Automática e IA

- Cuando se activa una regla de Respuesta Automática, el bot envía el texto del mensaje y el contexto de la conversación al proveedor de IA configurado por el operador, exactamente bajo los mismos términos, configuraciones y límites de privacidad que la función gratuita de IA.
- La memoria global a largo plazo se utiliza en una conversación de Respuesta Automática únicamente si el operador activa de forma explícita la memoria global para ese chat específico; de lo contrario, el acceso a la memoria permanece estrictamente restringido a ese chat individual.

---

## 9. Solicitudes de eliminación de datos

- Usted puede solicitar la eliminación de los registros del servicio de verificación asociados con su compra comunicándose con el Soporte de Leviro mediante **Ajustes > Comentarios** dentro de la aplicación.
- Google Play conserva sus propios registros de transacciones financieras e historial de compras de acuerdo con las políticas de retención de datos de Google.
