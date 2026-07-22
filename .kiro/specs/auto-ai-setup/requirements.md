# Requirements Document

## Introduction

`auto-ai-setup` es una CLI interactiva local para Node.js y TypeScript, ejecutable mediante `npx auto-ai-setup`, que prepara proyectos nuevos o existentes para trabajar con agentes de IA. El MVP analiza el proyecto, detecta el Stack y recomienda las CLI_Iniciales relacionadas con las tecnologías encontradas. También permite instalar o configurar Skills, Servidores_MCP, Reglas_de_Agente y Comandos_de_Agente. El MVP conserva la selección y aprobación del Usuario en Modo_Automático y Modo_Manual. Las Skills se consultan e instalan mediante `npx autoskills`, la CLI de midudev. El MVP se ejecuta localmente; solamente las consultas, descargas e instalaciones que el Usuario autorice pueden utilizar red. AWS Bedrock, el Backend_Serverless y los Hooks_de_Seguridad son Trabajo_Futuro y no forman parte del MVP.

### Códigos de salida

Para que los resultados sean fáciles de interpretar, CLI_Auto_AI_Setup utilizará estos códigos:

- `0`: ejecución exitosa o cancelación voluntaria antes de aplicar cambios.
- `1`: ocurrió un error al aplicar cambios, pero el proyecto fue restaurado correctamente.
- `2`: la entrada, ruta o configuración no es válida; no se aplican cambios.
- `3`: la ejecución quedó incompleta o la recuperación no pudo garantizar que el proyecto volviera a su estado anterior; se requiere revisión manual.


## Glossary

- **CLI_Auto_AI_Setup**: Aplicación de línea de comandos local proporcionada por este proyecto y ejecutable como `npx auto-ai-setup`.
- **Usuario**: Persona que ejecuta CLI_Auto_AI_Setup sobre un Proyecto_Objetivo.
- **Directorio_Válido**: Directorio existente cuya ruta canónica puede resolverse y en el cual CLI_Auto_AI_Setup puede enumerar entradas, leer archivos reconocidos y crear, leer y eliminar un archivo temporal de comprobación sin dejarlo en el directorio.
- **Proyecto_Objetivo**: Directorio_Válido seleccionado por el Usuario.
- **Archivo_de_Proyecto**: Archivo de implementación, manifiesto, bloqueo o configuración, distinto de los archivos creados exclusivamente por CLI_Auto_AI_Setup.
- **Proyecto_Nuevo**: Proyecto_Objetivo que no contiene ningún Archivo_de_Proyecto antes de la ejecución.
- **Proyecto_Existente**: Proyecto_Objetivo que contiene al menos un Archivo_de_Proyecto antes de la ejecución.
- **Stack**: Conjunto detectado de lenguajes, gestores de paquetes, frameworks y herramientas de un Proyecto_Objetivo.
- **Evidencia_de_Stack**: Ruta y dato reconocido de un archivo de manifiesto, bloqueo, configuración o código que sustenta la detección de un elemento del Stack.
- **Conflicto_de_Stack**: Detección de valores incompatibles para una misma categoría del Stack a partir de dos o más Evidencias_de_Stack.
- **CLI_del_Sistema**: Herramienta externa ejecutable desde el entorno local del Usuario.
- **CLI_Inicial**: Una de las cuatro CLI_del_Sistema que pueden recomendarse según el Stack detectado: `gh`, `supabase`, `vercel` o `playwright`.
- **Recomendación_de_CLI**: Sugerencia de una CLI_Inicial relacionada con una tecnología detectada en el Stack, sin comprobar si está instalada ni instalarla automáticamente.
- **Catálogo_Confiable**: Inventario de Skills proporcionado por la CLI `autoskills` de midudev, que constituye la única fuente admitida de Skills en el MVP.
- **Instantánea_del_Catálogo**: Conjunto de entradas devueltas por `npx autoskills`, con identidad, origen y metadatos, presentado al Usuario durante una ejecución.
- **Skill**: Paquete de instrucciones reutilizables para ampliar las capacidades de un agente de IA.
- **Servidor_MCP**: Componente local o configurado localmente que expone herramientas a agentes mediante Model Context Protocol.
- **Regla_de_Agente**: Instrucción persistente para agentes de IA almacenada en un archivo `AGENTS.md`.
- **Comando_de_Agente**: Acción reutilizable que un Usuario puede invocar desde un agente de IA compatible.
- **Componente**: Skill, Servidor_MCP, Regla_de_Agente o Comando_de_Agente gestionado por CLI_Auto_AI_Setup.
- **Modo_Automático**: Flujo que recomienda Componentes a partir del Stack y permite al Usuario retirar recomendaciones antes de aprobar cambios.
- **Modo_Manual**: Flujo que permite al Usuario seleccionar individualmente los Componentes antes de aprobar cambios.
- **Modo_Inválido**: Valor de modo distinto de Modo_Automático y Modo_Manual.
- **Plan_de_Cambios**: Inventario previo que detalla cada archivo, Componente y Operación_Externa propuestos, junto con su acción, destino, origen, motivo, conflicto y estado de aprobación.
- **Conflicto_de_Configuración**: Cambio propuesto sobre una ruta existente cuyo contenido o configuración efectiva no equivale al resultado propuesto.
- **Estado_Equivalente**: Estado observable que conserva los mismos archivos gestionados, Componentes instalados, valores de configuración y multiplicidad de entradas, ignorando únicamente orden y formato sin efecto semántico.
- **Ejecución_Idempotente**: Ejecución repetida con las mismas entradas que produce un Estado_Equivalente y una única instancia efectiva de cada Componente.
- **Configuración_Estructurada**: Archivo de configuración gestionado por CLI_Auto_AI_Setup cuyo formato y esquema están documentados por el proyecto.
- **Modelo_de_Configuración**: Representación en memoria de todos los campos de una Configuración_Estructurada, incluidos los campos no gestionados por CLI_Auto_AI_Setup.
- **Operación_Externa**: Descarga, instalación de paquete o ejecución de un proceso ajeno a CLI_Auto_AI_Setup.
- **Operación_de_Red**: Operación_Externa que envía o recibe datos mediante una conexión de red.
- **Registro_Local**: Evento estructurado mostrado en la terminal o escrito en el Proyecto_Objetivo, sin transmisión a servicios remotos.
- **Dato_Sensible**: Token, contraseña, clave privada, secreto o valor de credencial.
- **Modo_Detallado**: Opción que agrega Evidencias_de_Stack y decisiones de compatibilidad a los Registros_Locales.
- **Resumen_de_Ejecución**: Resultado final que enumera decisiones, cambios aplicados, elementos omitidos, advertencias, errores, estado y código de salida.
- **Ejecución_Incompleta**: Ejecución interrumpida antes de completar o restaurar la aplicación de cambios.
- **Perfil_de_Rendimiento**: Equipo local con cuatro núcleos de CPU disponibles, 8 GB de memoria y almacenamiento SSD, sobre un Proyecto_Objetivo de hasta 10 000 archivos y 500 MB, sin contar directorios excluidos.
- **Archivo_Analizable**: Evidencia_de_Stack o archivo de configuración de IA reconocido, excluidos directorios de dependencias, control de versiones, compilación y cobertura.
- **MVP**: Alcance funcional local definido por este documento.
- **Trabajo_Futuro**: Capacidad documentada que no se implementa, invoca ni requiere para ejecutar el MVP.
- **Hooks_de_Seguridad**: Automatizaciones futuras que inspeccionarán operaciones de agentes antes o después de ejecutarse.
- **Backend_Serverless**: Backend futuro desplegado como funciones o servicios administrados en AWS.
- **Demostración_AWS**: Evidencia separada del flujo principal del MVP que muestra una experimentación con servicios de AWS y no participa en la ejecución de CLI_Auto_AI_Setup.
- **SDD**: Desarrollo dirigido por especificaciones que mantiene requisitos, diseño, tareas y pruebas trazables.
- **Repositorio_Público**: Repositorio accesible sin autenticación y destinado a los entregables del hackathon.
- **Documentación_del_MVP**: Contenido del Repositorio_Público que delimita las capacidades incluidas y el Trabajo_Futuro.
- **Demostración_Funcional**: Evidencia reproducible de una ejecución del flujo principal de CLI_Auto_AI_Setup.

## Requirements

### Requirement 1: Inicio y selección del proyecto

**User Story:** Como Usuario, quiero ejecutar la herramienta con `npx`, para preparar un proyecto nuevo o existente sin una instalación global.

#### Acceptance Criteria

1. WHEN el Usuario ejecuta `npx auto-ai-setup`, THE CLI_Auto_AI_Setup SHALL iniciar un flujo interactivo en el entorno local.
2. WHEN el Usuario selecciona una ruta, THE CLI_Auto_AI_Setup SHALL comprobar la existencia de la ruta.
3. WHEN la ruta seleccionada existe, THE CLI_Auto_AI_Setup SHALL comprobar que la ruta corresponde a un directorio.
4. WHEN la ruta seleccionada corresponde a un directorio, THE CLI_Auto_AI_Setup SHALL comprobar que la ruta canónica puede resolverse.
5. WHEN la ruta canónica puede resolverse, THE CLI_Auto_AI_Setup SHALL comprobar la enumeración de entradas y la lectura de archivos reconocidos.
6. WHEN las comprobaciones de lectura finalizan correctamente, THE CLI_Auto_AI_Setup SHALL comprobar la creación, lectura y eliminación de un archivo temporal sin dejar el archivo temporal en la ruta seleccionada.
7. IF una comprobación de Directorio_Válido falla, THEN THE CLI_Auto_AI_Setup SHALL mostrar el nombre de la comprobación y la causa legible del fallo.
8. IF una comprobación de Directorio_Válido falla, THEN THE CLI_Auto_AI_Setup SHALL finalizar con código de salida 2 sin cambios persistentes en la ruta seleccionada.
9. WHEN todas las comprobaciones de Directorio_Válido finalizan correctamente, THE CLI_Auto_AI_Setup SHALL utilizar la ruta canónica como Proyecto_Objetivo.
10. WHEN CLI_Auto_AI_Setup clasifica el Proyecto_Objetivo, THE CLI_Auto_AI_Setup SHALL mostrar la cantidad de Archivos_de_Proyecto encontrada.
11. WHEN la cantidad de Archivos_de_Proyecto es cero, THE CLI_Auto_AI_Setup SHALL clasificar el Proyecto_Objetivo como Proyecto_Nuevo.
12. WHEN la cantidad de Archivos_de_Proyecto es mayor que cero, THE CLI_Auto_AI_Setup SHALL clasificar el Proyecto_Objetivo como Proyecto_Existente.
13. WHERE el Proyecto_Objetivo es un Proyecto_Nuevo, THE CLI_Auto_AI_Setup SHALL ofrecer la creación de la configuración inicial de IA.
14. WHERE el Proyecto_Objetivo es un Proyecto_Existente, THE CLI_Auto_AI_Setup SHALL incorporar la configuración preexistente reconocida al análisis de Conflictos_de_Configuración.

### Requirement 2: Análisis y detección del stack

**User Story:** Como Usuario, quiero que la herramienta reconozca el Stack del proyecto, para recibir opciones compatibles y relevantes.

#### Acceptance Criteria

1. WHEN comienza el análisis del Proyecto_Objetivo, THE CLI_Auto_AI_Setup SHALL identificar lenguajes mediante Evidencias_de_Stack reconocidas.
2. WHEN comienza el análisis del Proyecto_Objetivo, THE CLI_Auto_AI_Setup SHALL identificar gestores de paquetes mediante Evidencias_de_Stack reconocidas.
3. WHEN comienza el análisis del Proyecto_Objetivo, THE CLI_Auto_AI_Setup SHALL identificar frameworks mediante Evidencias_de_Stack reconocidas.
4. WHEN comienza el análisis del Proyecto_Objetivo, THE CLI_Auto_AI_Setup SHALL identificar herramientas mediante Evidencias_de_Stack reconocidas.
5. WHEN CLI_Auto_AI_Setup detecta un elemento del Stack, THE CLI_Auto_AI_Setup SHALL asociar el elemento con la ruta de cada Evidencia_de_Stack que sustenta la detección.
6. WHEN CLI_Auto_AI_Setup detecta un elemento del Stack, THE CLI_Auto_AI_Setup SHALL asociar el elemento con el dato reconocido de cada Evidencia_de_Stack que sustenta la detección.
7. WHEN finaliza el análisis del Proyecto_Objetivo, THE CLI_Auto_AI_Setup SHALL mostrar cada elemento detectado del Stack antes de recomendar Componentes.
8. WHEN finaliza el análisis del Proyecto_Objetivo, THE CLI_Auto_AI_Setup SHALL mostrar las Evidencias_de_Stack asociadas con cada elemento detectado.
9. WHEN CLI_Auto_AI_Setup analiza una Evidencia_de_Stack reconocida, THE CLI_Auto_AI_Setup SHALL validar la sintaxis antes de utilizar el dato para detectar el Stack.
10. IF una Evidencia_de_Stack reconocida tiene sintaxis inválida, THEN THE CLI_Auto_AI_Setup SHALL mostrar el error genérico `Configuración inválida`, indicando la ruta y la ubicación analizable del problema.
11. IF una Evidencia_de_Stack reconocida no puede leerse, THEN THE CLI_Auto_AI_Setup SHALL mostrar un error legible con la ruta y la causa.
12. IF dos o más Evidencias_de_Stack producen un Conflicto_de_Stack, THEN THE CLI_Auto_AI_Setup SHALL mostrar cada valor en conflicto.
13. IF dos o más Evidencias_de_Stack producen un Conflicto_de_Stack, THEN THE CLI_Auto_AI_Setup SHALL mostrar las rutas y los datos que sustentan cada valor en conflicto.
14. IF existe un Conflicto_de_Stack, THEN THE CLI_Auto_AI_Setup SHALL excluir las recomendaciones dependientes de la categoría en conflicto hasta que el Usuario seleccione explícitamente un valor.
15. IF ninguna Evidencia_de_Stack permite identificar un Stack compatible, THEN THE CLI_Auto_AI_Setup SHALL ofrecer el Modo_Manual sin recomendar Componentes.
16. IF ninguna Evidencia_de_Stack permite identificar un Stack compatible, THEN THE CLI_Auto_AI_Setup SHALL conservar sin cambios el Proyecto_Objetivo hasta que el Usuario apruebe un Plan_de_Cambios.

### Requirement 3: Recomendación de CLIs según el Stack

**User Story:** Como Usuario, quiero recibir recomendaciones de las CLIs relacionadas con las tecnologías de mi proyecto, para saber qué herramientas externas podrían serme útiles.

#### Acceptance Criteria

1. WHEN finaliza el análisis del Stack, THE CLI_Auto_AI_Setup SHALL evaluar qué CLI_Iniciales están relacionadas con las tecnologías detectadas.
2. WHEN CLI_Auto_AI_Setup detecta Supabase en el Stack, THE CLI_Auto_AI_Setup SHALL recomendar la CLI `supabase`.
3. WHEN CLI_Auto_AI_Setup detecta GitHub o GitHub Actions en el Stack, THE CLI_Auto_AI_Setup SHALL recomendar la CLI `gh`.
4. WHEN CLI_Auto_AI_Setup detecta Vercel en el Stack, THE CLI_Auto_AI_Setup SHALL recomendar la CLI `vercel`.
5. WHEN CLI_Auto_AI_Setup detecta Playwright en el Stack, THE CLI_Auto_AI_Setup SHALL recomendar la CLI `playwright`.
6. WHEN CLI_Auto_AI_Setup presenta una Recomendación_de_CLI, THE CLI_Auto_AI_Setup SHALL mostrar el nombre de la CLI, la tecnología que la motivó y la Evidencia_de_Stack correspondiente.
7. WHEN CLI_Auto_AI_Setup presenta una Recomendación_de_CLI, THE CLI_Auto_AI_Setup SHALL mostrar una explicación sencilla del uso que podría tener esa CLI en el proyecto.
8. IF el Stack contiene varias tecnologías relacionadas con la misma CLI_Inicial, THEN THE CLI_Auto_AI_Setup SHALL mostrar una sola recomendación de esa CLI e indicar las evidencias relacionadas.
9. IF ninguna tecnología detectada se relaciona con una CLI_Inicial, THEN THE CLI_Auto_AI_Setup SHALL informar que no hay recomendaciones de CLIs basadas en el Stack.
10. WHEN CLI_Auto_AI_Setup genera una Recomendación_de_CLI, THE CLI_Auto_AI_Setup SHALL no comprobar si la CLI está instalada.
11. WHEN CLI_Auto_AI_Setup genera una Recomendación_de_CLI, THE CLI_Auto_AI_Setup SHALL no instalar ni ejecutar automáticamente la CLI recomendada.
12. WHEN el Usuario selecciona una Recomendación_de_CLI para incluirla en su preparación, THE CLI_Auto_AI_Setup SHALL incluir en el Plan_de_Cambios el nombre de la CLI, la razón de la recomendación y las instrucciones de instalación o consulta documentadas, sin instalarla automáticamente.
13. IF una recomendación depende de una Evidencia_de_Stack conflictiva, THEN THE CLI_Auto_AI_Setup SHALL marcarla como pendiente hasta que el Usuario resuelva el Conflicto_de_Stack.

### Requirement 4: Modos automático y manual

**User Story:** Como Usuario, quiero elegir entre automatización guiada y selección granular, para adaptar la configuración a mi nivel de control deseado.

#### Acceptance Criteria

1. WHEN el Usuario no especifica un modo al iniciar, THE CLI_Auto_AI_Setup SHALL solicitar la elección entre Modo_Automático y Modo_Manual.
2. IF el Usuario proporciona un Modo_Inválido, THEN THE CLI_Auto_AI_Setup SHALL mostrar Modo_Automático y Modo_Manual como los únicos modos válidos.
3. IF el Usuario proporciona un Modo_Inválido, THEN THE CLI_Auto_AI_Setup SHALL solicitar una nueva elección sin modificar el Proyecto_Objetivo.
4. WHERE el Usuario elige el Modo_Automático, THE CLI_Auto_AI_Setup SHALL recomendar Componentes compatibles con el Stack confirmado y con las Recomendaciones_de_CLI relacionadas.
5. WHERE el Usuario elige el Modo_Automático, THE CLI_Auto_AI_Setup SHALL permitir retirar individualmente cada Componente recomendado antes de generar el Plan_de_Cambios.
6. WHERE el Usuario elige el Modo_Manual, THE CLI_Auto_AI_Setup SHALL presentar los Componentes disponibles agrupados como Skills, Servidores_MCP, Reglas_de_Agente y Comandos_de_Agente.
7. WHERE el Usuario elige el Modo_Manual, THE CLI_Auto_AI_Setup SHALL permitir seleccionar individualmente cada Componente antes de generar el Plan_de_Cambios.
8. WHEN la selección final contiene cero Componentes, THE CLI_Auto_AI_Setup SHALL omitir la generación del Plan_de_Cambios.
9. WHEN la selección final contiene cero Componentes, THE CLI_Auto_AI_Setup SHALL finalizar sin solicitar aprobación para aplicar cambios.
10. WHEN la selección final contiene cero Componentes, THE CLI_Auto_AI_Setup SHALL conservar sin cambios el Proyecto_Objetivo.
11. WHEN la selección final contiene cero Componentes, THE CLI_Auto_AI_Setup SHALL emitir un Resumen_de_Ejecución exitoso con cero cambios y código de salida 0.
12. WHEN la selección final contiene uno o más Componentes, THE CLI_Auto_AI_Setup SHALL requerir la aprobación definida en el Requirement 7 antes de aplicar cambios.

### Requirement 5: Gestión de Skills mediante autoskills

**User Story:** Como Usuario, quiero consultar e instalar Skills usando la CLI oficial de midudev, para utilizar una fuente conocida y un proceso de instalación estandarizado.

#### Acceptance Criteria

1. WHEN CLI_Auto_AI_Setup necesita construir el inventario de Skills, THE CLI_Auto_AI_Setup SHALL mostrar que ejecutará `npx autoskills`, solicitar autorización para esa consulta y ejecutarlo solamente después de recibirla.
2. WHEN CLI_Auto_AI_Setup construye el inventario de Skills, THE CLI_Auto_AI_Setup SHALL incluir exclusivamente las entradas proporcionadas por la CLI `autoskills` de midudev.
3. WHEN CLI_Auto_AI_Setup presenta una Skill, THE CLI_Auto_AI_Setup SHALL mostrar el nombre de la Skill.
4. WHEN CLI_Auto_AI_Setup presenta una Skill, THE CLI_Auto_AI_Setup SHALL mostrar la descripción de la Skill.
5. WHEN CLI_Auto_AI_Setup presenta una Skill, THE CLI_Auto_AI_Setup SHALL mostrar su origen y la compatibilidad detectada.
6. WHEN el Usuario selecciona una Skill, THE CLI_Auto_AI_Setup SHALL incluir su identidad, origen, destino y la operación de instalación mediante la CLI de midudev en el Plan_de_Cambios.
7. WHEN el Usuario aprueba la instalación de una Skill, THE CLI_Auto_AI_Setup SHALL utilizar el comando oficial de instalación de `autoskills` de midudev, en lugar de descargar o instalar directamente los archivos de la Skill.
8. WHEN CLI_Auto_AI_Setup instala una Skill, THE CLI_Auto_AI_Setup SHALL verificar que la identidad y el origen de la Skill coinciden con la entrada presentada por `npx autoskills` durante la ejecución.
9. IF una Skill no fue proporcionada por `npx autoskills`, THEN THE CLI_Auto_AI_Setup SHALL rechazar la instalación y mostrar la discrepancia encontrada.
10. IF la identidad o el origen de una Skill no coincide con la información proporcionada por `npx autoskills`, THEN THE CLI_Auto_AI_Setup SHALL rechazar la instalación y mostrar la discrepancia encontrada.
11. IF `npx autoskills` no puede ejecutarse o no puede obtener el inventario, THEN THE CLI_Auto_AI_Setup SHALL mostrar una causa legible y excluir las Skills de la selección.
12. IF la respuesta de `npx autoskills` no puede validarse, THEN THE CLI_Auto_AI_Setup SHALL mostrar una causa legible y excluir las Skills de la selección.
13. IF `npx autoskills` no puede ejecutarse, obtenerse o validarse, THEN THE CLI_Auto_AI_Setup SHALL continuar ofreciendo los tipos de Componente que no dependen de Skills.
14. IF la instalación de una Skill mediante `autoskills` falla, THEN THE CLI_Auto_AI_Setup SHALL eliminar los artefactos parciales creados por esa instalación.
15. IF la instalación de una Skill mediante `autoskills` falla, THEN THE CLI_Auto_AI_Setup SHALL activar la recuperación definida en el Requirement 8.

### Requirement 6: Configuración de MCP, reglas y comandos

**User Story:** Como Usuario, quiero configurar herramientas e instrucciones para agentes de IA, para disponer de un entorno coherente con mi proyecto.

#### Acceptance Criteria

1. WHEN CLI_Auto_AI_Setup presenta Servidores_MCP, THE CLI_Auto_AI_Setup SHALL mostrar un inventario de los Servidores_MCP disponibles.
2. WHEN CLI_Auto_AI_Setup presenta un Servidor_MCP, THE CLI_Auto_AI_Setup SHALL mostrar el nombre, el propósito y la compatibilidad detectada del Servidor_MCP.
3. WHEN el Usuario selecciona un Servidor_MCP compatible, THE CLI_Auto_AI_Setup SHALL incluir cada archivo requerido por el Servidor_MCP en el Plan_de_Cambios.
4. WHEN el Usuario selecciona un Servidor_MCP compatible, THE CLI_Auto_AI_Setup SHALL incluir cada Operación_Externa requerida por el Servidor_MCP en el Plan_de_Cambios.
5. WHEN un Servidor_MCP requiere variables de entorno, THE CLI_Auto_AI_Setup SHALL mostrar solamente los nombres de las variables requeridas en el Plan_de_Cambios.
6. WHEN el Usuario selecciona una Regla_de_Agente, THE CLI_Auto_AI_Setup SHALL proponer la incorporación identificable de la Regla_de_Agente al archivo `AGENTS.md` aplicable.
7. WHEN el Usuario selecciona un Comando_de_Agente, THE CLI_Auto_AI_Setup SHALL proponer la creación o actualización de la Configuración_Estructurada del agente compatible.
8. IF un Componente es incompatible con el Stack confirmado, THEN THE CLI_Auto_AI_Setup SHALL mostrar la condición de compatibilidad incumplida.
9. IF un Componente es incompatible con las Recomendaciones_de_CLI relacionadas con el Stack, THEN THE CLI_Auto_AI_Setup SHALL mostrar la condición de compatibilidad incumplida.
10. IF el Usuario intenta incluir manualmente un Componente incompatible, THEN THE CLI_Auto_AI_Setup SHALL solicitar una confirmación específica que identifique el Componente y la incompatibilidad.
11. IF el Usuario rechaza la confirmación de un Componente incompatible, THEN THE CLI_Auto_AI_Setup SHALL excluir el Componente del Plan_de_Cambios.
12. IF el Usuario aprueba la confirmación de un Componente incompatible, THEN THE CLI_Auto_AI_Setup SHALL marcar la incompatibilidad en el Plan_de_Cambios.

### Requirement 7: Planificación, consentimiento y seguridad de cambios

**User Story:** Como Usuario, quiero revisar y aprobar los cambios antes de aplicarlos, para conservar el control sobre la configuración del proyecto.

#### Acceptance Criteria

1. WHEN el Usuario completa una selección con uno o más Componentes, THE CLI_Auto_AI_Setup SHALL generar el Plan_de_Cambios antes de cualquier mutación del Proyecto_Objetivo.
2. WHEN el Usuario completa una selección con uno o más Componentes, THE CLI_Auto_AI_Setup SHALL generar el Plan_de_Cambios antes de iniciar cualquier Operación_Externa de descarga, instalación o modificación del Proyecto_Objetivo. La consulta autorizada de `npx autoskills` para construir el inventario se rige por el Requirement 5.
3. WHEN CLI_Auto_AI_Setup muestra el Plan_de_Cambios, THE CLI_Auto_AI_Setup SHALL enumerar la ruta canónica de cada archivo propuesto.
4. WHEN CLI_Auto_AI_Setup muestra un archivo propuesto, THE CLI_Auto_AI_Setup SHALL identificar la acción como crear, modificar o conservar.
5. WHEN CLI_Auto_AI_Setup muestra un archivo propuesto, THE CLI_Auto_AI_Setup SHALL identificar el Componente asociado y el motivo del cambio.
6. WHEN CLI_Auto_AI_Setup muestra un archivo propuesto, THE CLI_Auto_AI_Setup SHALL identificar la presencia o ausencia de un Conflicto_de_Configuración.
7. WHEN CLI_Auto_AI_Setup muestra un Plan_de_Cambios que contiene una Operación_Externa, THE CLI_Auto_AI_Setup SHALL mostrar el comando o la acción, el origen, el destino y el propósito de la Operación_Externa.
8. WHEN CLI_Auto_AI_Setup muestra un Plan_de_Cambios que contiene una Operación_Externa, THE CLI_Auto_AI_Setup SHALL indicar si la Operación_Externa utiliza red.
9. WHEN el Plan_de_Cambios contiene la creación o modificación de un archivo no estructurado, THE CLI_Auto_AI_Setup SHALL mostrar una vista previa del contenido propuesto.
10. WHEN el Plan_de_Cambios contiene la creación o modificación de una Configuración_Estructurada, THE CLI_Auto_AI_Setup SHALL mostrar un resumen campo por campo del cambio propuesto.
11. WHEN el Plan_de_Cambios no contiene Conflictos_de_Configuración, THE CLI_Auto_AI_Setup SHALL solicitar una confirmación global que abarque todos los cambios y Operaciones_Externas enumerados.
12. IF el Plan_de_Cambios contiene un Conflicto_de_Configuración, THEN THE CLI_Auto_AI_Setup SHALL solicitar una decisión separada de conservar o reemplazar para cada archivo en conflicto.
13. IF el Usuario elige conservar un archivo en conflicto, THEN THE CLI_Auto_AI_Setup SHALL mantener sin cambios el contenido preexistente.
14. IF el Usuario elige conservar un archivo en conflicto, THEN THE CLI_Auto_AI_Setup SHALL marcar el cambio como omitido en el Plan_de_Cambios.
15. IF el Usuario elige reemplazar un archivo en conflicto, THEN THE CLI_Auto_AI_Setup SHALL registrar la aprobación específica del archivo antes de aplicar el reemplazo.
16. IF el Usuario cancela antes de completar las confirmaciones del Plan_de_Cambios, THEN THE CLI_Auto_AI_Setup SHALL conservar el Estado_Equivalente anterior del Proyecto_Objetivo.
17. IF el Usuario cancela antes de completar las confirmaciones del Plan_de_Cambios, THEN THE CLI_Auto_AI_Setup SHALL finalizar con código de salida 0.
18. IF una ruta de destino resuelta queda fuera de la ruta canónica del Proyecto_Objetivo, THEN THE CLI_Auto_AI_Setup SHALL rechazar el cambio correspondiente.
19. IF una ruta de destino resuelta queda fuera de la ruta canónica del Proyecto_Objetivo, THEN THE CLI_Auto_AI_Setup SHALL finalizar con código de salida 2 antes de aplicar cambios.
20. WHEN CLI_Auto_AI_Setup muestra una vista previa, THE CLI_Auto_AI_Setup SHALL sustituir cada Dato_Sensible detectado por el marcador `[REDACTED]`.
21. WHEN CLI_Auto_AI_Setup genera un Registro_Local, THE CLI_Auto_AI_Setup SHALL sustituir cada Dato_Sensible detectado por el marcador `[REDACTED]`.

### Requirement 8: Aplicación recuperable y resultados

**User Story:** Como Usuario, quiero que la aplicación de cambios sea recuperable, para evitar estados parciales ante un fallo.

#### Acceptance Criteria

1. WHEN el Usuario completa las aprobaciones del Plan_de_Cambios, THE CLI_Auto_AI_Setup SHALL aplicar únicamente los archivos aprobados.
2. WHEN el Usuario completa las aprobaciones del Plan_de_Cambios, THE CLI_Auto_AI_Setup SHALL aplicar únicamente los Componentes aprobados.
3. WHEN el Usuario completa las aprobaciones del Plan_de_Cambios, THE CLI_Auto_AI_Setup SHALL ejecutar únicamente las Operaciones_Externas aprobadas.
4. WHEN comienza la aplicación del Plan_de_Cambios, THE CLI_Auto_AI_Setup SHALL conservar una copia recuperable del contenido previo de cada archivo que modificará.
5. WHEN comienza la aplicación del Plan_de_Cambios, THE CLI_Auto_AI_Setup SHALL registrar la inexistencia previa de cada archivo que creará.
6. WHEN todos los cambios aprobados finalizan correctamente, THE CLI_Auto_AI_Setup SHALL eliminar las copias temporales de recuperación creadas por la ejecución.
7. WHEN todos los cambios aprobados finalizan correctamente, THE CLI_Auto_AI_Setup SHALL emitir un Resumen_de_Ejecución exitoso con código de salida 0.
8. IF falla un cambio aprobado, THEN THE CLI_Auto_AI_Setup SHALL restaurar el contenido previo de cada archivo modificado por la ejecución.
9. IF falla un cambio aprobado, THEN THE CLI_Auto_AI_Setup SHALL eliminar cada archivo creado por la ejecución.
10. IF falla un cambio aprobado, THEN THE CLI_Auto_AI_Setup SHALL eliminar los artefactos parciales de Componentes creados por la ejecución.
11. IF falla un cambio aprobado, THEN THE CLI_Auto_AI_Setup SHALL emitir un Resumen_de_Ejecución fallido que identifique el cambio y la causa.
12. IF falla un cambio aprobado, THEN THE CLI_Auto_AI_Setup SHALL incluir el resultado de la recuperación en el Resumen_de_Ejecución.
13. IF la recuperación restaura el Estado_Equivalente anterior, THEN THE CLI_Auto_AI_Setup SHALL finalizar con código de salida 1.
14. IF la recuperación no restaura el Estado_Equivalente anterior, THEN THE CLI_Auto_AI_Setup SHALL finalizar con código de salida 3.
15. IF ocurre una Ejecución_Incompleta, THEN THE CLI_Auto_AI_Setup SHALL finalizar con código de salida 3.
16. IF la ejecución finaliza con código de salida 3, THEN THE CLI_Auto_AI_Setup SHALL enumerar las rutas que requieren revisión manual.
17. WHEN finaliza la aplicación del Plan_de_Cambios, THE CLI_Auto_AI_Setup SHALL enumerar los cambios aplicados, los elementos omitidos, las advertencias y los errores en el Resumen_de_Ejecución.

### Requirement 9: Idempotencia

**User Story:** Como Usuario, quiero repetir la configuración con seguridad, para mantener el proyecto sin duplicados ni cambios innecesarios.

#### Acceptance Criteria

1. WHEN CLI_Auto_AI_Setup vuelve a ejecutarse con el mismo Proyecto_Objetivo, modo, Stack confirmado y selección sobre un Estado_Equivalente, THE CLI_Auto_AI_Setup SHALL generar un Plan_de_Cambios con cero creaciones, modificaciones e instalaciones.
2. WHEN CLI_Auto_AI_Setup vuelve a ejecutarse con las mismas entradas sobre un Estado_Equivalente, THE CLI_Auto_AI_Setup SHALL conservar sin cambios los archivos gestionados y los valores de configuración.
3. WHEN CLI_Auto_AI_Setup vuelve a ejecutarse con las mismas entradas sobre un Estado_Equivalente, THE CLI_Auto_AI_Setup SHALL omitir las Operaciones_Externas que producirían un Componente ya presente.
4. WHEN CLI_Auto_AI_Setup encuentra una Skill con la misma identidad, origen y destino que una Skill seleccionada, THE CLI_Auto_AI_Setup SHALL conservar una única instalación efectiva de la Skill.
5. WHEN CLI_Auto_AI_Setup encuentra una Regla_de_Agente con el mismo contenido normalizado que una Regla_de_Agente seleccionada, THE CLI_Auto_AI_Setup SHALL conservar una única instancia efectiva de la Regla_de_Agente.
6. WHEN CLI_Auto_AI_Setup encuentra un Servidor_MCP con el mismo identificador y los mismos valores de configuración que un Servidor_MCP seleccionado, THE CLI_Auto_AI_Setup SHALL conservar una única configuración efectiva del Servidor_MCP.
7. WHEN CLI_Auto_AI_Setup encuentra un Comando_de_Agente con el mismo identificador y la misma definición que un Comando_de_Agente seleccionado, THE CLI_Auto_AI_Setup SHALL conservar una única configuración efectiva del Comando_de_Agente.
8. WHEN CLI_Auto_AI_Setup finaliza una Ejecución_Idempotente, THE CLI_Auto_AI_Setup SHALL informar cero cambios en el Resumen_de_Ejecución.

### Requirement 10: Configuraciones estructuradas

**User Story:** Como mantenedor, quiero preservar configuraciones válidas al leerlas y escribirlas, para evitar corrupción o pérdida semántica.

#### Acceptance Criteria

1. WHEN CLI_Auto_AI_Setup analiza una Configuración_Estructurada válida, THE CLI_Auto_AI_Setup SHALL producir un Modelo_de_Configuración que contenga cada campo presente en el archivo.
2. WHEN CLI_Auto_AI_Setup analiza una Configuración_Estructurada válida, THE CLI_Auto_AI_Setup SHALL conservar el valor asociado con cada campo presente en el archivo.
3. IF una Configuración_Estructurada incumple el formato documentado, THEN THE CLI_Auto_AI_Setup SHALL mostrar la ruta, la ubicación analizable y la causa del incumplimiento.
4. IF una Configuración_Estructurada incumple el esquema documentado, THEN THE CLI_Auto_AI_Setup SHALL mostrar la ruta, la ubicación analizable y la causa del incumplimiento.
5. WHEN CLI_Auto_AI_Setup serializa un Modelo_de_Configuración, THE CLI_Auto_AI_Setup SHALL producir sintaxis válida para el formato documentado.
6. WHEN CLI_Auto_AI_Setup serializa un Modelo_de_Configuración, THE CLI_Auto_AI_Setup SHALL producir una configuración válida para el esquema documentado.
7. WHEN una Configuración_Estructurada válida completa el ciclo analizar, serializar y analizar, THE CLI_Auto_AI_Setup SHALL producir un segundo Modelo_de_Configuración con los mismos campos que el primer Modelo_de_Configuración.
8. WHEN una Configuración_Estructurada válida completa el ciclo analizar, serializar y analizar, THE CLI_Auto_AI_Setup SHALL producir un segundo Modelo_de_Configuración con el mismo valor para cada campo que el primer Modelo_de_Configuración.
9. WHEN CLI_Auto_AI_Setup modifica una Configuración_Estructurada, THE CLI_Auto_AI_Setup SHALL conservar sin cambios cada campo preexistente ajeno al cambio aprobado.
10. WHEN CLI_Auto_AI_Setup modifica una Configuración_Estructurada, THE CLI_Auto_AI_Setup SHALL conservar sin cambios el valor de cada campo preexistente ajeno al cambio aprobado.
11. WHEN CLI_Auto_AI_Setup serializa una Configuración_Estructurada modificada, THE CLI_Auto_AI_Setup SHALL conservar los campos desconocidos admitidos por el formato.
12. WHEN CLI_Auto_AI_Setup serializa una Configuración_Estructurada modificada, THE CLI_Auto_AI_Setup SHALL conservar el valor original de cada campo desconocido admitido por el formato.

### Requirement 11: Observabilidad local

**User Story:** Como Usuario, quiero diagnósticos locales claros, para comprender decisiones y resolver fallos sin exponer secretos.

#### Acceptance Criteria

1. WHEN CLI_Auto_AI_Setup inicia una ejecución, THE CLI_Auto_AI_Setup SHALL asignar un identificador único a la ejecución.
2. WHEN ocurre una decisión, THE CLI_Auto_AI_Setup SHALL emitir un Registro_Local con identificador de ejecución, marca temporal, nivel, categoría y mensaje.
3. WHEN ocurre una advertencia, THE CLI_Auto_AI_Setup SHALL emitir un Registro_Local con identificador de ejecución, marca temporal, nivel, categoría y mensaje.
4. WHEN ocurre un cambio, THE CLI_Auto_AI_Setup SHALL emitir un Registro_Local con identificador de ejecución, marca temporal, nivel, categoría y mensaje.
5. WHEN ocurre un error, THE CLI_Auto_AI_Setup SHALL emitir un Registro_Local con identificador de ejecución, marca temporal, nivel, categoría y mensaje.
6. WHERE el Usuario activa el Modo_Detallado, THE CLI_Auto_AI_Setup SHALL incluir las rutas de Evidencias_de_Stack en los Registros_Locales.
7. WHERE el Usuario activa el Modo_Detallado, THE CLI_Auto_AI_Setup SHALL incluir las decisiones de compatibilidad en los Registros_Locales.
8. WHEN CLI_Auto_AI_Setup genera un Registro_Local, THE CLI_Auto_AI_Setup SHALL escribir el Registro_Local solamente en la terminal o en archivos dentro del Proyecto_Objetivo.
9. WHEN CLI_Auto_AI_Setup genera un Registro_Local, THE CLI_Auto_AI_Setup SHALL mantener el Registro_Local sin transmisión mediante red.
10. WHEN CLI_Auto_AI_Setup genera un Registro_Local, THE CLI_Auto_AI_Setup SHALL sustituir cada Dato_Sensible detectado por el marcador `[REDACTED]`.
11. WHEN finaliza una ejecución, THE CLI_Auto_AI_Setup SHALL incluir el identificador único de la ejecución en el Resumen_de_Ejecución.

### Requirement 12: Rendimiento y uso de recursos

**User Story:** Como Usuario, quiero una herramienta ágil y acotada, para integrarla en el flujo de preparación del proyecto.

#### Acceptance Criteria

1. THE Documentación_del_MVP SHALL definir un procedimiento reproducible de medición que identifique el Perfil_de_Rendimiento, el Proyecto_Objetivo de prueba, el estado de caché, el comando y el número de ejecuciones.
2. WHILE CLI_Auto_AI_Setup opera bajo el Perfil_de_Rendimiento con la caché del sistema de archivos vacía o caliente, THE CLI_Auto_AI_Setup SHALL completar el análisis local desde el inicio del recorrido hasta la presentación del Stack en un máximo de 10 segundos en al menos 9 de 10 ejecuciones consecutivas.
3. WHILE CLI_Auto_AI_Setup opera bajo el Perfil_de_Rendimiento, THE CLI_Auto_AI_Setup SHALL mantener un máximo de 512 MB de memoria residente durante el análisis local.
4. WHEN CLI_Auto_AI_Setup recorre un Proyecto_Objetivo, THE CLI_Auto_AI_Setup SHALL excluir los directorios de dependencias documentados por el proyecto.
5. WHEN CLI_Auto_AI_Setup recorre un Proyecto_Objetivo, THE CLI_Auto_AI_Setup SHALL excluir los directorios de control de versiones documentados por el proyecto.
6. WHEN CLI_Auto_AI_Setup recorre un Proyecto_Objetivo, THE CLI_Auto_AI_Setup SHALL excluir los directorios de compilación documentados por el proyecto.
7. WHEN CLI_Auto_AI_Setup recorre un Proyecto_Objetivo, THE CLI_Auto_AI_Setup SHALL excluir los directorios de cobertura documentados por el proyecto.
8. WHEN CLI_Auto_AI_Setup completa el análisis local, THE CLI_Auto_AI_Setup SHALL incluir la cantidad de Archivos_Analizables recorridos en el Resumen_de_Ejecución.
9. WHEN CLI_Auto_AI_Setup completa el análisis local, THE CLI_Auto_AI_Setup SHALL incluir el tiempo transcurrido en el Resumen_de_Ejecución.
10. IF el Proyecto_Objetivo supera 10 000 archivos sin contar directorios excluidos, THEN THE CLI_Auto_AI_Setup SHALL informar que los límites verificables del Perfil_de_Rendimiento no aplican a la ejecución.
11. IF el Proyecto_Objetivo supera 500 MB sin contar directorios excluidos, THEN THE CLI_Auto_AI_Setup SHALL informar que los límites verificables del Perfil_de_Rendimiento no aplican a la ejecución.

### Requirement 13: Calidad, mantenibilidad y estrategia de pruebas

**User Story:** Como mantenedor, quiero una base de código comprobable y modular, para evolucionar el producto durante y después del hackathon.

#### Acceptance Criteria

1. THE CLI_Auto_AI_Setup SHALL compilar todo el código TypeScript del MVP con comprobaciones estrictas y cero errores de tipos.
2. THE CLI_Auto_AI_Setup SHALL mantener una cobertura automatizada mínima del 80 % de líneas del código fuente del MVP.
3. THE CLI_Auto_AI_Setup SHALL mantener una cobertura automatizada mínima del 80 % de funciones del código fuente del MVP.
4. THE CLI_Auto_AI_Setup SHALL mantener una cobertura automatizada mínima del 80 % de ramas del código fuente del MVP.
5. THE CLI_Auto_AI_Setup SHALL incluir pruebas unitarias con Evidencias_de_Stack válidas, inválidas, ausentes y conflictivas.
6. THE CLI_Auto_AI_Setup SHALL incluir pruebas unitarias para Plan_de_Cambios sin cambios, con creaciones, con modificaciones, con Operaciones_Externas y con Conflictos_de_Configuración.
7. THE CLI_Auto_AI_Setup SHALL incluir pruebas basadas en propiedades que ejecuten al menos 100 proyectos generados por corrida para verificar la Ejecución_Idempotente.
8. THE CLI_Auto_AI_Setup SHALL incluir pruebas basadas en propiedades que ejecuten al menos 100 proyectos generados por corrida para verificar la ausencia de Componentes duplicados.
9. THE CLI_Auto_AI_Setup SHALL incluir pruebas basadas en propiedades que ejecuten al menos 100 modelos válidos por formato admitido y por corrida para verificar el ciclo analizar, serializar y analizar de las Configuraciones_Estructuradas.
10. THE CLI_Auto_AI_Setup SHALL incluir pruebas basadas en propiedades que ejecuten al menos 100 modelos válidos por formato admitido y por corrida para verificar la preservación campo por campo de valores no gestionados.
11. THE CLI_Auto_AI_Setup SHALL incluir pruebas de integración del Modo_Automático para recomendación, retiro de una recomendación, aprobación y cancelación.
12. THE CLI_Auto_AI_Setup SHALL incluir pruebas de integración del Modo_Manual para selección individual, cero selecciones, aprobación y Modo_Inválido.
13. THE CLI_Auto_AI_Setup SHALL incluir pruebas de integración separadas para Proyecto_Nuevo y Proyecto_Existente.
14. THE CLI_Auto_AI_Setup SHALL incluir pruebas de integración para aprobación global, aprobación por conflicto y rechazo de conflicto.
15. THE CLI_Auto_AI_Setup SHALL incluir pruebas de integración para fallo de aplicación y fallo de recuperación.
16. THE CLI_Auto_AI_Setup SHALL incluir pruebas de integración para Operación_de_Red aprobada y Operación_de_Red no aprobada.
17. WHEN una solicitud de cambio se evalúa para integración o se integra en la rama principal, THE Repositorio_Público SHALL ejecutar formato, análisis estático, comprobación de tipos, pruebas, umbrales de cobertura y compilación mediante automatización continua.
18. IF cualquier comprobación de automatización continua falla, THEN THE Repositorio_Público SHALL marcar la ejecución como fallida.
19. IF cualquier métrica de cobertura no alcanza el 80 %, THEN THE Repositorio_Público SHALL marcar la ejecución como fallida.
20. THE CLI_Auto_AI_Setup SHALL mantener trazabilidad bidireccional entre cada requisito, elemento de diseño, tarea y prueba mediante SDD.

### Requirement 14: Documentación y entregables del hackathon

**User Story:** Como evaluador del hackathon, quiero acceder al producto, su arquitectura y una demostración, para comprobar impacto, innovación y funcionamiento.

#### Acceptance Criteria

1. THE Repositorio_Público SHALL permitir acceso sin autenticación a la licencia.
2. THE Repositorio_Público SHALL permitir acceso sin autenticación al código fuente.
3. THE Repositorio_Público SHALL permitir acceso sin autenticación a los documentos SDD.
4. THE Repositorio_Público SHALL incluir un `README.md` con requisitos previos, ejecución mediante `npx`, Modo_Automático y Modo_Manual.
5. THE Repositorio_Público SHALL incluir comandos reproducibles de ejemplo en el `README.md`.
6. THE Repositorio_Público SHALL incluir comandos reproducibles para ejecutar formato, análisis estático, comprobación de tipos, pruebas, cobertura y compilación.
7. THE Repositorio_Público SHALL incluir una descripción de los componentes de arquitectura.
8. THE Repositorio_Público SHALL incluir una descripción de las decisiones técnicas principales.
9. THE Repositorio_Público SHALL incluir al menos un diagrama de arquitectura legible desde el Repositorio_Público.
10. THE Repositorio_Público SHALL incluir al menos un diagrama de flujo o caso de uso legible desde el Repositorio_Público.
11. THE Repositorio_Público SHALL incluir una sección de seguridad que documente el Catálogo_Confiable, la redacción de Datos_Sensibles, la aprobación de cambios y la autorización de Operaciones_de_Red.
12. THE Repositorio_Público SHALL enlazar una Demostración_Funcional públicamente accesible que muestre selección de proyecto, detección de Stack, selección de modo, Plan_de_Cambios, aprobación y Resumen_de_Ejecución.
13. THE Repositorio_Público SHALL enlazar un video público con duración máxima de 5 minutos.
14. THE Repositorio_Público SHALL enlazar un video público que muestre el problema, la solución, el uso de Kiro y una ejecución funcional.
15. THE Repositorio_Público SHALL describir el impacto tecnológico de CLI_Auto_AI_Setup.
16. THE Repositorio_Público SHALL describir los elementos innovadores de CLI_Auto_AI_Setup.
17. THE Repositorio_Público SHALL identificar las capacidades de Kiro utilizadas durante el SDD y el desarrollo.
18. WHERE se publica una Demostración_AWS para el hackathon, THE Repositorio_Público SHALL identificar la Demostración_AWS como experimento independiente y Trabajo_Futuro.
19. WHERE se publica una Demostración_AWS para el hackathon, THE Demostración_AWS SHALL poder ejecutarse sin intervenir en archivos, procesos ni resultados de CLI_Auto_AI_Setup.

### Requirement 15: Alcance local, red y evolución futura

**User Story:** Como responsable del producto, quiero delimitar el MVP y documentar su evolución, para entregar una solución funcional sin prometer capacidades pendientes.

#### Acceptance Criteria

1. THE MVP SHALL limitar el análisis del Proyecto_Objetivo al entorno local.
2. THE MVP SHALL limitar la interacción, la planificación y los Registros_Locales al entorno local.
3. THE MVP SHALL limitar los cambios de archivos al Proyecto_Objetivo.
4. WHEN una descarga o instalación seleccionada requiere una Operación_de_Red, THE CLI_Auto_AI_Setup SHALL identificar el origen, el destino y el propósito en el Plan_de_Cambios antes de solicitar aprobación.
5. IF una Operación_de_Red carece de origen, destino o propósito en el Plan_de_Cambios, THEN THE CLI_Auto_AI_Setup SHALL rechazar la ejecución de la Operación_de_Red.
6. WHEN el Usuario aprueba explícitamente una Operación_de_Red enumerada, THE CLI_Auto_AI_Setup SHALL ejecutar solamente la Operación_de_Red aprobada como parte de la aplicación del Plan_de_Cambios.
7. IF el Usuario no aprueba una Operación_de_Red, THEN THE CLI_Auto_AI_Setup SHALL omitir la Operación_de_Red sin abrir la conexión asociada.
8. IF el Usuario no aprueba una Operación_de_Red, THEN THE CLI_Auto_AI_Setup SHALL omitir la Operación_de_Red sin iniciar el proceso asociado.
9. IF una Operación_de_Red solicitada no figura en el Plan_de_Cambios aprobado, THEN THE CLI_Auto_AI_Setup SHALL rechazar la Operación_de_Red y registrar el rechazo localmente.
10. THE Documentación_del_MVP SHALL clasificar la inferencia mediante AWS Bedrock como Trabajo_Futuro no implementado en el MVP.
11. THE Documentación_del_MVP SHALL clasificar el Backend_Serverless en AWS como Trabajo_Futuro no implementado en el MVP.
12. THE Documentación_del_MVP SHALL clasificar los Hooks_de_Seguridad como Trabajo_Futuro no implementado en el MVP.
13. THE Demostración_Funcional SHALL ejecutar el flujo principal sin invocar AWS Bedrock.
14. THE Demostración_Funcional SHALL ejecutar el flujo principal sin invocar un Backend_Serverless.
15. THE Demostración_Funcional SHALL ejecutar el flujo principal sin invocar Hooks_de_Seguridad.
16. WHERE existe una Demostración_AWS, THE CLI_Auto_AI_Setup SHALL completar el flujo principal con independencia de la disponibilidad o el estado de la Demostración_AWS.
