# LuxHort Clima — la aplicación

Panel de control de una sala de cultivo: CO₂, temperatura, humedad, VPD,
sustrato, fotoperiodo y riego. Muestra y permite modificar lo mismo que
la pantalla táctil del tablero.

## Por qué la clave está a la vista

`config.js` lleva la URL del proyecto de Supabase y la clave `anon`. Las
dos son **públicas por diseño**: la clave `anon` viaja dentro de toda
aplicación web que use Supabase y cualquiera que abra la página la puede
leer.

Lo que protege los datos **no es el secreto de la clave**, son las
políticas de acceso de la base. Sin haber iniciado sesión, con la `anon`
en la mano no se lee ninguna tabla; con sesión iniciada, sólo se ven las
salas de las que se es miembro. Está verificado, no supuesto.

La que **nunca** aparece acá ni en ningún otro lado del lado del cliente
es la `service_role`: ésa saltea todas las políticas.

## El equipo nunca acepta conexiones entrantes

La aplicación no le habla al controlador. Escribe una orden en la base y
el equipo la busca. Un puerto abierto hacia un controlador que maneja
una válvula de gas lo encuentran los buscadores de dispositivos
expuestos en horas, no en meses.

Y una orden desde acá se ejecuta por el **mismo camino** que un toque en
la pantalla del tablero, con las mismas verificaciones. No hay una vía
«de la app» que saltee nada.

## Los controles no se escriben acá

`parametros.js` se genera desde el firmware de la pantalla con
`tools/gen_parametros.py`. Etiquetas, pasos, límites, formatos y
secciones salen de ahí. **No editar a mano**: se regenera.
