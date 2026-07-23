# Requirements Document

## Introduction

Este documento define una interfaz de terminal moderna (TUI) para `auto-ai-setup`. La experiencia interactiva debe ser pulida, coherente y comparable en calidad de interacción con herramientas de terminal modernas, sin copiar nombres, logotipos, textos, paletas ni otros elementos de identidad de productos externos. La mejora se limita a la presentación y la interacción: conserva el producto como CLI local, mantiene planes deterministas y exige aprobación explícita antes de cualquier mutación.

La TUI mantiene las fronteras actuales del producto. Los cambios continúan siendo locales y recuperables; los datos sensibles se redactan; solamente las operaciones de `autoskills` aprobadas explícitamente pueden utilizar red; y la herramienta no ejecuta comandos arbitrarios, servidores MCP, CLIs recomendadas ni scripts de ciclo de vida. Los modos no interactivo y JSON conservan sus contratos actuales. El repositorio utiliza pnpm como gestor de paquetes, aunque los contratos públicos `npx auto-ai-setup` y `npx autoskills` permanecen vigentes.

## Glossary

- **CLI_Auto_AI_Setup**: Aplicación de línea de comandos local proporcionada por el proyecto `auto-ai-setup`.
- **TUI_Moderna**: Capa de presentación interactiva de CLI_Auto_AI_Setup que organiza contenido, controles y estados dentro de una terminal.
- **Sesión_Interactiva**: Ejecución en la que la entrada estándar y la salida estándar están conectadas a una Terminal TTY y el Usuario puede responder a controles en tiempo real.
- **Usuario**: Persona que ejecuta CLI_Auto_AI_Setup.
- **Terminal**: Entorno de texto que proporciona entrada, salida, dimensiones y un conjunto detectable de capacidades visuales.
- **Capacidades_de_Terminal**: Valores detectados de TTY para entrada y salida, reposicionamiento ANSI del cursor, color, Unicode, cantidad de columnas y cantidad de filas.
- **Dimensiones_Válidas**: Cantidades enteras positivas de columnas y filas informadas por la Terminal.
- **Terminal_Completa**: Terminal con entrada y salida TTY, reposicionamiento ANSI del cursor, color, Unicode y Dimensiones_Válidas de al menos 80 columnas por 24 filas.
- **Modo_Visual_Completo**: Presentación de TUI_Moderna utilizada exclusivamente con una Terminal_Completa.
- **Modo_Degradado**: Presentación que reduce adornos, reorganiza regiones o sustituye recursos no compatibles sin ocultar información ni acciones esenciales.
- **Modo_Texto_Lineal**: Presentación secuencial sin reposicionamiento de cursor, color, Unicode, animaciones ni controles dependientes de pantalla completa.
- **Salida_Redirigida**: Salida estándar que no está conectada a una TTY.
- **Contenido_Esencial**: Títulos de etapa, opciones, valores seleccionados, advertencias, errores, detalles del Plan_de_Cambios, acciones disponibles y Resumen_Final.
- **Sistema_Visual**: Reglas coherentes de jerarquía, espaciado, bordes, símbolos, color y ubicación aplicadas por TUI_Moderna.
- **Vista**: Representación de una etapa de la Sesión_Interactiva.
- **Control_Interactivo**: Opción, selector, botón textual o campo que acepta una acción del Usuario.
- **Acción_de_Avance**: Acción que abandona la Vista actual para iniciar la siguiente etapa del flujo.
- **Foco**: Identificación del único Control_Interactivo habilitado que recibirá la siguiente acción de navegación o activación.
- **Orden_de_Navegación_Circular**: Secuencia documentada de Controles_Interactivos habilitados ordenada de arriba hacia abajo y de izquierda a derecha, en la que avanzar desde el último control selecciona el primero y retroceder desde el primero selecciona el último.
- **Atajo_de_Teclado**: Tecla documentada que ejecuta una acción de navegación o selección dentro de una Vista.
- **Ayuda_Contextual**: Lista visible bajo demanda de Atajos_de_Teclado y acciones disponibles para la Vista actual.
- **Estado_de_Sesión**: Conjunto nombrado de etapa actual, selecciones, Foco almacenado, Plan_de_Cambios, aprobaciones, resultado acumulado, posición de desplazamiento, entradas no confirmadas, validaciones pendientes y modo de presentación.
- **Indicador_de_Progreso**: Representación textual y opcionalmente animada del trabajo en curso.
- **Progreso_Determinado**: Progreso con cantidades enteras no negativas de unidades completadas y totales.
- **Progreso_Indeterminado**: Progreso para el cual no se conoce la cantidad total de unidades de trabajo.
- **Mensaje_de_Error**: Descripción visible de una condición fallida, su contexto y la acción disponible para continuar, corregir o finalizar.
- **Control_de_Recuperación_Registrado**: Acción de reintentar, corregir, recuperar o finalizar declarada por la etapa fallida, con estado habilitado o deshabilitado.
- **Resultado_de_Recuperación**: Estado visible de recuperación completada, parcial, fallida o no requerida después de un fallo.
- **Plan_de_Cambios**: Inventario determinista de archivos, componentes y operaciones externas propuestos antes de cualquier Mutación.
- **Representación_Canónica_del_Plan**: Secuencia de bytes estable del Plan_de_Cambios, con campos y operaciones en orden canónico.
- **Hash_del_Plan**: Identificador SHA-256 calculado desde la Representación_Canónica_del_Plan.
- **Mutación**: Creación, modificación o eliminación persistente de archivos o configuración del proyecto objetivo.
- **Aprobación_Explícita**: Confirmación afirmativa del Usuario asociada con el Hash_del_Plan mostrado y obtenida mediante una acción distinta de la opción predeterminada.
- **Dato_Sensible**: Token, contraseña, clave privada, secreto o valor de credencial.
- **Resumen_Final**: Resultado de la ejecución que presenta estado, cambios, omisiones, advertencias, errores, recuperación y código de salida.
- **Modo_No_Interactivo**: Ejecución que recibe todas las decisiones requeridas mediante argumentos o entrada automatizada y no solicita respuestas en tiempo real.
- **Modo_JSON**: Variante de Modo_No_Interactivo que emite exclusivamente el contrato JSON público vigente de CLI_Auto_AI_Setup.
- **Contrato_CLI_Existente**: Sintaxis, nombres de comandos, argumentos, opciones, entradas, salidas, esquema JSON, códigos de salida, etapas, decisiones y semántica pública definidos antes de TUI_Moderna.
- **Operación_Autoskills_Aprobada**: Consulta o instalación mediante el flujo oficial `npx autoskills` que el Usuario autorizó explícitamente como parte del Plan_de_Cambios vigente.
- **Operación_Prohibida**: Ejecución de una CLI recomendada, un servidor MCP, un comando de shell arbitrario, un script de ciclo de vida, telemetría, un backend remoto o un hook de seguridad.
- **Estado_Equivalente**: Estado observable con los mismos archivos gestionados, componentes, valores de configuración, campos desconocidos, orden de elementos no relacionados y multiplicidad de entradas.
- **Perfil_de_Rendimiento_TUI**: Equipo local con cuatro núcleos de CPU disponibles, 8 GB de memoria y almacenamiento SSD, usando una Terminal_Completa y un Plan_de_Cambios de hasta 1 000 operaciones visibles.
- **Evento_de_Interfaz**: Entrada recibida por TUI_Moderna que inicia una medición de respuesta, incluida navegación, cambio de dimensiones o actualización de actividad.
- **NO_COLOR**: Convención de entorno que solicita salida sin color cuando la variable `NO_COLOR` está presente con cualquier valor distinto de una cadena vacía.
- **Identidad_Visual_Propia**: Nombre, textos, símbolos y combinación visual pertenecientes a `auto-ai-setup`, sin reproducir nombres, logotipos, textos, paletas ni otros elementos identificables de productos externos.
- **Adaptador_de_Terminal**: Frontera sustituible que proporciona capacidades, dimensiones, entrada, salida y tiempo a TUI_Moderna durante ejecución y pruebas.
- **Modelo_de_Vista**: Representación determinista y libre de efectos externos del contenido, orden, controles, etiquetas, desplazamiento y Foco de una Vista.
- **Matriz_de_Compatibilidad**: Combinaciones de Windows Terminal con PowerShell, Terminal de macOS y una terminal Linux compatible con xterm, cruzadas con entrada o salida sin TTY, color presente o ausente, Unicode presente o ausente, reposicionamiento ANSI presente o ausente, dimensiones menores, iguales o mayores que 80 por 24, Dimensiones_Válidas o inválidas y NO_COLOR activo o inactivo.
- **Efectos_Externos**: Las seis fronteras inyectables de entrada, salida, tiempo, sistema de archivos, procesos y red.
- **Recurso_Falso**: Implementación local inyectada de un Efecto_Externo para pruebas, configurada como disponible o no disponible.
- **Flujo_de_Repositorio**: Instalación de dependencias, ejecución de scripts, pruebas, compilación y empaquetado realizados por contribuidores dentro del repositorio.

## Requirements

### Requirement 1: Compatibilidad de terminal y degradación funcional

**User Story:** Como Usuario, quiero que la interfaz se adapte a las capacidades de mi terminal, para completar el flujo sin pérdida de información ni controles.

#### Acceptance Criteria

1. WHEN CLI_Auto_AI_Setup inicia una ejecución, THE CLI_Auto_AI_Setup SHALL detectar TTY de entrada y salida, reposicionamiento ANSI del cursor, color, Unicode y Dimensiones_Válidas antes de emitir salida.
2. WHEN todas las Capacidades_de_Terminal cumplen la definición de Terminal_Completa, THE TUI_Moderna SHALL utilizar el Modo_Visual_Completo.
3. IF cualquier Capacidad_de_Terminal es desconocida o las dimensiones no son enteros positivos, THEN THE TUI_Moderna SHALL utilizar el Modo_Texto_Lineal con ASCII y sin color.
4. IF la Terminal carece de reposicionamiento ANSI del cursor, THEN THE TUI_Moderna SHALL utilizar el Modo_Texto_Lineal sin emitir secuencias de control no admitidas.
5. IF la Terminal carece de color o NO_COLOR solicita salida sin color, THEN THE TUI_Moderna SHALL omitir códigos ANSI de color y expresar mediante texto cada significado visual.
6. IF la Terminal carece de Unicode, THEN THE TUI_Moderna SHALL sustituir cada borde, icono y símbolo Unicode por un equivalente ASCII distinguible.
7. IF la Terminal tiene Dimensiones_Válidas inferiores a 80 columnas o 24 filas y admite reposicionamiento ANSI, THEN THE TUI_Moderna SHALL utilizar el Modo_Degradado sin emitir secuencias de control no admitidas.
8. IF la salida estándar es una Salida_Redirigida, THEN THE CLI_Auto_AI_Setup SHALL omitir los controles interactivos y las secuencias ANSI conforme al Contrato_CLI_Existente.
9. WHEN cambian las dimensiones durante una Sesión_Interactiva, THE TUI_Moderna SHALL conservar cada campo nombrado del Estado_de_Sesión al seleccionar la presentación compatible.
10. WHEN CLI_Auto_AI_Setup se ejecuta en cualquier combinación de la Matriz_de_Compatibilidad, THE CLI_Auto_AI_Setup SHALL permitir alcanzar finalización, cancelación o error controlado mediante acciones documentadas.
11. WHEN la Terminal informa exactamente 80 columnas por 24 filas y satisface las demás condiciones de Terminal_Completa, THE TUI_Moderna SHALL utilizar el Modo_Visual_Completo.

### Requirement 2: Interacción, navegación y conservación del estado

**User Story:** Como Usuario, quiero navegar de forma predecible usando el teclado, para revisar y ajustar decisiones sin perder el contexto.

#### Acceptance Criteria

1. THE TUI_Moderna SHALL documentar y aplicar el Orden_de_Navegación_Circular en cada Vista.
2. WHEN una Vista contiene uno o más Controles_Interactivos habilitados, THE TUI_Moderna SHALL mostrar exactamente un Foco.
3. WHEN el Usuario pulsa `Tab` o la tecla de avance documentada, THE TUI_Moderna SHALL mover el Foco una posición hacia adelante en el Orden_de_Navegación_Circular.
4. WHEN el Usuario pulsa `Shift+Tab` o la tecla de retroceso documentada, THE TUI_Moderna SHALL mover el Foco una posición hacia atrás en el Orden_de_Navegación_Circular.
5. WHEN el Usuario pulsa `Enter` sobre el Control_Interactivo con Foco, THE TUI_Moderna SHALL activar exactamente una vez la acción etiquetada.
6. WHEN el Usuario pulsa `Space` sobre una opción multiselección con Foco, THE TUI_Moderna SHALL alternar exactamente una vez la selección de la opción.
7. WHEN el Usuario regresa a una Vista, THE TUI_Moderna SHALL restaurar el Foco almacenado solamente cuando el control asociado permanece visible y habilitado.
8. IF el Foco almacenado no corresponde a un control visible y habilitado, THEN THE TUI_Moderna SHALL asignar el Foco al primer Control_Interactivo habilitado del Orden_de_Navegación_Circular.
9. IF una acción no es válida para la Vista actual, THEN THE TUI_Moderna SHALL conservar la Vista y cada campo del Estado_de_Sesión sin cambios.
10. WHEN el Control_Interactivo con Foco queda fuera de las filas visibles, THE TUI_Moderna SHALL desplazar el número mínimo de filas necesario para mostrar el control completo.
11. WHEN todo el contenido de la Vista cabe en las filas disponibles, THE TUI_Moderna SHALL mantener la posición de desplazamiento en cero.
12. IF un valor restaurado incumple una o más reglas vigentes, THEN THE TUI_Moderna SHALL conservar el valor, mostrar cada regla incumplida y bloquear las Acciones_de_Avance.
13. WHILE una validación requerida permanece pendiente, THE TUI_Moderna SHALL bloquear solamente las Acciones_de_Avance.
14. THE TUI_Moderna SHALL permitir navegar, editar, seleccionar, activar, abrir ayuda, cancelar y finalizar mediante teclado sin requerir ratón.
15. WHERE las Capacidades_de_Terminal incluyen entrada de ratón, THE TUI_Moderna SHALL permitir activar cada Control_Interactivo mediante ratón como alternativa opcional.
16. WHEN el Usuario solicita cancelar antes de una Mutación, THE TUI_Moderna SHALL mostrar una confirmación con la continuación de la sesión como opción predeterminada.
17. WHEN el Usuario confirma la cancelación antes de una Mutación, THE CLI_Auto_AI_Setup SHALL finalizar con el código de cancelación del Contrato_CLI_Existente y conservar el Estado_Equivalente del proyecto.

### Requirement 3: Sistema visual e identidad coherente

**User Story:** Como Usuario, quiero una presentación clara y consistente, para comprender la etapa actual, la información relevante y la siguiente acción.

#### Acceptance Criteria

1. THE Sistema_Visual SHALL distinguir títulos, texto principal, texto secundario, selección, advertencia, error, éxito y Foco mediante al menos un atributo no basado en color.
2. WHEN TUI_Moderna muestra una Vista, THE TUI_Moderna SHALL mostrar `auto-ai-setup`, la etapa actual y una acción primaria habilitada aplicable al estado actual.
3. WHEN TUI_Moderna representa éxito, advertencia o error, THE TUI_Moderna SHALL usar respectivamente las etiquetas `ÉXITO`, `ADVERTENCIA` o `ERROR` y símbolos distintos compatibles con la presentación activa.
4. WHEN el contenido supera el ancho disponible, THE TUI_Moderna SHALL ajustar las líneas de forma determinista dentro del ancho sin alterar el orden del contenido.
5. WHEN una ruta supera el ancho disponible, THE TUI_Moderna SHALL truncar la ruta dentro del ancho y mostrar un indicador de truncamiento.
6. WHEN TUI_Moderna actualiza un Indicador_de_Progreso, THE TUI_Moderna SHALL conservar sin cambios los caracteres y posiciones de las regiones cuyo Modelo_de_Vista no cambió.
7. THE TUI_Moderna SHALL utilizar la Identidad_Visual_Propia en todas las presentaciones.
8. WHEN TUI_Moderna selecciona Modo_Degradado o Modo_Texto_Lineal, THE TUI_Moderna SHALL conservar la jerarquía, las etiquetas y el Contenido_Esencial del Modo_Visual_Completo.
9. WHEN TUI_Moderna muestra acciones equivalentes en Vistas distintas, THE TUI_Moderna SHALL utilizar las mismas etiquetas textuales.
10. IF una presentación no puede representar un adorno, THEN THE TUI_Moderna SHALL sustituir el adorno sin eliminar ni renombrar el Contenido_Esencial asociado.

### Requirement 4: Accesibilidad de la experiencia interactiva

**User Story:** Como Usuario con distintas necesidades visuales o de interacción, quiero alternativas textuales y control total por teclado, para utilizar el producto sin depender de color, animación o precisión motriz.

#### Acceptance Criteria

1. THE TUI_Moderna SHALL proporcionar etiquetas textuales explícitas para Foco, selección, estado y acciones disponibles.
2. WHEN un Control_Interactivo recibe Foco, THE TUI_Moderna SHALL mostrar un marcador textual o de forma que no se utilice para ningún estado distinto del Foco.
3. WHEN NO_COLOR solicita salida sin color, THE TUI_Moderna SHALL emitir cero códigos ANSI de color.
4. WHILE una actividad permanece en curso, THE TUI_Moderna SHALL mostrar una descripción textual persistente de la actividad.
5. WHERE el Usuario selecciona presentación sin animaciones, THE TUI_Moderna SHALL mostrar un estado textual estático y actualizarlo solamente cuando cambie la actividad descrita.
6. WHEN TUI_Moderna utiliza el Modo_Texto_Lineal, THE TUI_Moderna SHALL emitir títulos, estados, etiquetas, valores y acciones en el orden secuencial del flujo.
7. WHILE el Usuario edita una entrada, THE TUI_Moderna SHALL mantener visible la etiqueta textual asociada.
8. IF una entrada incumple reglas de validación, THEN THE TUI_Moderna SHALL conservar el valor editable y enumerar cada regla incumplida.
9. WHEN el Usuario pulsa `?`, THE TUI_Moderna SHALL alternar la visibilidad de la Ayuda_Contextual sin cambiar el Foco ni las selecciones.
10. WHILE una entrada es inválida, THE TUI_Moderna SHALL deshabilitar cada Acción_de_Avance.

### Requirement 5: Progreso, errores y resultados accionables

**User Story:** Como Usuario, quiero conocer el avance y entender los fallos, para decidir si debo esperar, corregir una entrada o iniciar recuperación.

#### Acceptance Criteria

1. WHEN una etapa alcanza un segundo sin finalizar, THE TUI_Moderna SHALL mostrar un Indicador_de_Progreso con el nombre de la etapa.
2. WHEN TUI_Moderna recibe Progreso_Determinado válido, THE TUI_Moderna SHALL verificar que ambas cantidades sean enteros no negativos, que las unidades completadas no disminuyan y que las unidades completadas no superen las unidades totales.
3. WHEN un Progreso_Determinado válido tiene una o más unidades totales, THE TUI_Moderna SHALL mostrar las cantidades y el piso de `completadas × 100 / total` como porcentaje entero.
4. WHEN un Progreso_Determinado válido tiene cero unidades completadas y cero unidades totales, THE TUI_Moderna SHALL mostrar `0%`.
5. IF un Progreso_Determinado incumple una regla, THEN THE TUI_Moderna SHALL conservar la última representación válida y mostrar la regla incumplida.
6. WHEN TUI_Moderna recibe Progreso_Indeterminado, THE TUI_Moderna SHALL mostrar la descripción de actividad sin porcentaje ni cantidades de unidades.
7. WHEN TUI_Moderna muestra progreso, errores o resultados, THE TUI_Moderna SHALL redactar cada Dato_Sensible antes de emitir cualquier carácter correspondiente.
8. IF una operación falla, THEN THE TUI_Moderna SHALL conservar cada campo del Estado_de_Sesión y mostrar la etapa, la operación y la causa legible.
9. IF una operación falla, THEN THE TUI_Moderna SHALL mostrar solamente los Controles_de_Recuperación_Registrados e indicar el estado habilitado o deshabilitado de cada control.
10. IF una Mutación falla, THEN THE TUI_Moderna SHALL esperar un Resultado_de_Recuperación visible antes de presentar el Resumen_Final.
11. WHEN TUI_Moderna presenta el Resumen_Final, THE TUI_Moderna SHALL incluir estado, cambios, omisiones, Resultado_de_Recuperación, código de salida y todos los errores y advertencias de la ejecución.
12. IF una recuperación deja rutas sin resolver, THEN THE TUI_Moderna SHALL enumerar cada ruta sin resolver exactamente una vez en el Resumen_Final.

### Requirement 6: Revisión determinista y aprobación segura del plan

**User Story:** Como Usuario, quiero revisar un plan estable y aprobarlo conscientemente, para mantener control sobre cada cambio local y operación externa.

#### Acceptance Criteria

1. WHEN CLI_Auto_AI_Setup recibe entradas equivalentes y un Estado_Equivalente del proyecto, THE CLI_Auto_AI_Setup SHALL producir una Representación_Canónica_del_Plan byte a byte idéntica.
2. WHEN CLI_Auto_AI_Setup produce una Representación_Canónica_del_Plan, THE CLI_Auto_AI_Setup SHALL calcular el Hash_del_Plan mediante SHA-256 sobre esos bytes.
3. WHEN TUI_Moderna presenta un Plan_de_Cambios, THE TUI_Moderna SHALL mostrar las operaciones en orden canónico y el Hash_del_Plan.
4. WHEN TUI_Moderna presenta una operación, THE TUI_Moderna SHALL mostrar acción, destino, origen, motivo y estado de conflicto, usando `no aplicable` para cada campo sin valor.
5. WHEN una operación modifica contenido existente, THE TUI_Moderna SHALL mostrar una descripción semántica redactada de los valores anterior y posterior.
6. WHEN una operación externa está permitida, THE TUI_Moderna SHALL mostrar el comando permitido, todos sus argumentos, el propósito y el uso de red, usando `no aplicable` para cada campo sin valor.
7. WHEN TUI_Moderna muestra valores originales del proyecto dentro del Plan_de_Cambios, THE TUI_Moderna SHALL redactar cada Dato_Sensible antes de emitir los valores.
8. WHEN TUI_Moderna solicita la Aprobación_Explícita, THE TUI_Moderna SHALL seleccionar el rechazo como decisión predeterminada.
9. IF el Hash_del_Plan vigente difiere del Hash_del_Plan mostrado, THEN THE CLI_Auto_AI_Setup SHALL invalidar la aprobación y bloquear Mutaciones y operaciones externas.
10. WHEN el Usuario concede Aprobación_Explícita para el Hash_del_Plan vigente, THE CLI_Auto_AI_Setup SHALL aplicar exactamente las operaciones de la Representación_Canónica_del_Plan aprobada.
11. IF el Usuario rechaza el Plan_de_Cambios, THEN THE CLI_Auto_AI_Setup SHALL conservar el Estado_Equivalente del proyecto.
12. IF CLI_Auto_AI_Setup recibe decisiones de aprobación y rechazo en conflicto, THEN THE CLI_Auto_AI_Setup SHALL descartar ambas decisiones y exigir una nueva decisión inequívoca.
13. WHILE no existe una Aprobación_Explícita válida para el Hash_del_Plan vigente, THE CLI_Auto_AI_Setup SHALL bloquear Mutaciones y operaciones externas.
14. WHERE una Operación_Autoskills_Aprobada declara uso de red, THE CLI_Auto_AI_Setup SHALL permitir red solamente durante esa operación aprobada.
15. IF una operación propuesta es una Operación_Prohibida, THEN THE CLI_Auto_AI_Setup SHALL rechazar la operación antes de incorporarla al Plan_de_Cambios.
16. WHEN CLI_Auto_AI_Setup aplica un Plan_de_Cambios aprobado, THE CLI_Auto_AI_Setup SHALL conservar copia, diario persistente, verificación, aplicación transaccional, reversión y recuperación local.
17. WHEN el Usuario emite una nueva Aprobación_Explícita inequívoca después de un rechazo, THE CLI_Auto_AI_Setup SHALL asociar la nueva decisión solamente con el Hash_del_Plan mostrado en esa solicitud.

### Requirement 7: Preservación de modos no interactivo y JSON

**User Story:** Como responsable de automatización, quiero que la nueva TUI no altere las interfaces procesables, para conservar scripts e integraciones existentes.

#### Acceptance Criteria

1. WHEN el Usuario invoca el Modo_No_Interactivo, THE CLI_Auto_AI_Setup SHALL omitir TUI_Moderna y conservar el Contrato_CLI_Existente completo.
2. WHEN el Usuario invoca el Modo_JSON, THE CLI_Auto_AI_Setup SHALL emitir exactamente un valor JSON conforme al esquema y la semántica del Contrato_CLI_Existente.
3. WHEN el Usuario invoca el Modo_JSON, THE CLI_Auto_AI_Setup SHALL emitir cero secuencias ANSI, animaciones, marcos y solicitudes interactivas en la salida estándar.
4. IF falta una entrada requerida en el Modo_No_Interactivo, THEN THE CLI_Auto_AI_Setup SHALL finalizar sin esperar entrada y conservar el Estado_Equivalente del proyecto.
5. WHEN la entrada estándar o la salida estándar está redirigida, THE CLI_Auto_AI_Setup SHALL omitir la activación de Controles_Interactivos.
6. WHEN finaliza una ejecución no interactiva, THE CLI_Auto_AI_Setup SHALL conservar el código de salida del Contrato_CLI_Existente.
7. WHEN un Plan_de_Cambios no interactivo va a ejecutarse, THE CLI_Auto_AI_Setup SHALL verificar que la aprobación proporcionada coincide con el Hash_del_Plan vigente antes de cualquier Mutación.
8. WHEN CLI_Auto_AI_Setup prepara salida JSON, THE CLI_Auto_AI_Setup SHALL completar la redacción de Datos_Sensibles antes de escribir el primer byte en la salida estándar.
9. IF la redacción de la salida JSON falla, THEN THE CLI_Auto_AI_Setup SHALL emitir cero bytes en la salida estándar y finalizar con el error del Contrato_CLI_Existente.
10. IF la aprobación no coincide con el Hash_del_Plan vigente, THEN THE CLI_Auto_AI_Setup SHALL bloquear Mutaciones, bloquear operaciones externas y conservar el Estado_Equivalente del proyecto.

### Requirement 8: Capacidad de respuesta y estabilidad de renderizado

**User Story:** Como Usuario, quiero que la interfaz responda de forma inmediata y estable, para mantener confianza durante análisis y planes extensos.

#### Acceptance Criteria

1. WHEN CLI_Auto_AI_Setup recibe la finalización de la validación inicial en el Perfil_de_Rendimiento_TUI, THE TUI_Moderna SHALL mostrar la primera Vista visible en un máximo de 300 milisegundos.
2. WHEN TUI_Moderna recibe un Evento_de_Interfaz de navegación en el Perfil_de_Rendimiento_TUI, THE TUI_Moderna SHALL mostrar el nuevo Foco o selección en un máximo de 100 milisegundos.
3. WHEN TUI_Moderna recibe un Evento_de_Interfaz de cambio de dimensiones en el Perfil_de_Rendimiento_TUI, THE TUI_Moderna SHALL mostrar la Vista adaptada en un máximo de 250 milisegundos.
4. WHILE una actividad permanece en curso en el Perfil_de_Rendimiento_TUI, THE TUI_Moderna SHALL mostrar una actualización o confirmación textual dentro de cada intervalo de un segundo desde el Evento_de_Interfaz anterior.
5. WHEN TUI_Moderna muestra un Plan_de_Cambios de 1 000 operaciones en el Perfil_de_Rendimiento_TUI, THE TUI_Moderna SHALL cumplir el límite de navegación de 100 milisegundos.
6. WHEN TUI_Moderna completa un renderizado, THE Terminal SHALL contener solamente los caracteres del Modelo_de_Vista vigente.
7. WHILE una tarea de aplicación continúa en segundo plano, THE TUI_Moderna SHALL impedir que la navegación cambie las entradas o el resultado de la tarea.
8. IF TUI_Moderna puede conservar cada campo nombrado del Estado_de_Sesión durante una transición a Modo_Degradado, THEN THE TUI_Moderna SHALL conservar además la posición de desplazamiento y las entradas no confirmadas.
9. IF TUI_Moderna no puede conservar un elemento durante una transición de presentación, THEN THE TUI_Moderna SHALL permanecer en el modo vigente, identificar el elemento no preservable y mostrar los Controles_de_Recuperación_Registrados disponibles.
10. WHILE TUI_Moderna permanece en el modo vigente por una transición imposible, THE TUI_Moderna SHALL evitar nuevas secuencias de control no admitidas por las Capacidades_de_Terminal actuales.

### Requirement 9: Testabilidad determinista de la presentación

**User Story:** Como mantenedor, quiero verificar la interfaz sin depender de terminales o redes reales, para prevenir regresiones de comportamiento y seguridad.

#### Acceptance Criteria

1. WHEN las pruebas inyectan entradas, Estado_de_Sesión, capacidades y dimensiones equivalentes, THE TUI_Moderna SHALL producir Modelos_de_Vista con contenido, orden y Foco idénticos.
2. WHEN las pruebas repiten una secuencia generada de entre 1 y 100 pulsaciones, THE TUI_Moderna SHALL producir la misma secuencia de Estados_de_Sesión.
3. WHEN las pruebas recorren cada combinación de la Matriz_de_Compatibilidad, THE TUI_Moderna SHALL conservar el Contenido_Esencial y omitir recursos no admitidos.
4. WHEN las pruebas generan dimensiones entre 1 y 500 columnas y entre 1 y 200 filas, THE TUI_Moderna SHALL conservar cada campo nombrado del Estado_de_Sesión después del cambio.
5. WHEN una secuencia de navegación válida alcanza una Vista con controles habilitados, THE TUI_Moderna SHALL mantener exactamente un Foco sobre un Control_Interactivo habilitado.
6. IF las pruebas generan una acción inválida, THEN THE TUI_Moderna SHALL conservar el Estado_de_Sesión y evitar Mutaciones.
7. WHEN cualquier entrada de prueba contiene un literal de Dato_Sensible, THE Modelo_de_Vista y cada salida capturada SHALL omitir el literal.
8. WHEN las pruebas evalúan un límite de 100, 250, 300 o 1 000 milisegundos, THE TUI_Moderna SHALL permitir observaciones a un milisegundo antes, en el límite exacto y a un milisegundo después.
9. THE CLI_Auto_AI_Setup SHALL permitir inyectar los seis Efectos_Externos sin utilizar una Terminal real ni una red pública.
10. IF un Recurso_Falso está configurado como no disponible, THEN THE CLI_Auto_AI_Setup SHALL producir un error controlado sin recurrir al Efecto_Externo real correspondiente.

### Requirement 10: Compatibilidad del CLI y fronteras del producto

**User Story:** Como Usuario existente, quiero recibir la nueva experiencia sin cambios incompatibles, para continuar utilizando los mismos comandos y garantías de seguridad.

#### Acceptance Criteria

1. WHEN TUI_Moderna se incorpora a CLI_Auto_AI_Setup, THE CLI_Auto_AI_Setup SHALL conservar exactamente la sintaxis, los nombres, los argumentos, las opciones, la semántica y los códigos de salida del Contrato_CLI_Existente.
2. WHEN el Usuario ejecuta `npx auto-ai-setup`, THE CLI_Auto_AI_Setup SHALL conservar las etapas y decisiones vigentes mientras selecciona la presentación según las Capacidades_de_Terminal.
3. WHEN un contribuidor instala dependencias, ejecuta scripts, prueba, compila o empaqueta el repositorio, THE Flujo_de_Repositorio SHALL utilizar exclusivamente pnpm.
4. WHEN la documentación para contribuidores muestra comandos del Flujo_de_Repositorio, THE documentación SHALL mostrar exclusivamente comandos pnpm.
5. WHEN CLI_Auto_AI_Setup consulta o instala Skills, THE CLI_Auto_AI_Setup SHALL utilizar solamente una Operación_Autoskills_Aprobada mediante el flujo oficial `npx autoskills`.
6. WHEN CLI_Auto_AI_Setup actualiza configuración, THE CLI_Auto_AI_Setup SHALL preservar campos desconocidos, orden de elementos de arrays no relacionados y multiplicidad de entradas.
7. WHEN CLI_Auto_AI_Setup prepara una Mutación, THE CLI_Auto_AI_Setup SHALL validar contención léxica y real dentro del proyecto objetivo y mantener recuperación local.
8. IF una ruta contiene traversal, una ruta absoluta o de dispositivo, un carácter NUL o un escape mediante enlace simbólico, THEN THE CLI_Auto_AI_Setup SHALL rechazar la ruta antes de iniciar procesos o Mutaciones.
9. THE CLI_Auto_AI_Setup SHALL limitar la ejecución de procesos a las Operaciones_Autoskills_Aprobadas del Hash_del_Plan vigente.
10. IF una acción solicita una Operación_Prohibida, THEN THE CLI_Auto_AI_Setup SHALL rechazar la acción antes de iniciar procesos o Mutaciones.
11. WHEN CLI_Auto_AI_Setup genera eventos o salida local, THE CLI_Auto_AI_Setup SHALL omitir telemetría y transmisión remota de eventos.
12. WHEN TUI_Moderna presenta CLIs recomendadas o servidores MCP, THE TUI_Moderna SHALL describir o configurar las opciones sin ejecutar las CLIs ni los servidores MCP.
13. IF una Operación_Autoskills_Aprobada falla, THEN THE CLI_Auto_AI_Setup SHALL mostrar el fallo y los Controles_de_Recuperación_Registrados sin iniciar descargas directas ni flujos alternativos de instalación.
