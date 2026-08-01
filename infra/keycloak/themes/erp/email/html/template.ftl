<#--
    Maqueta comun de TODOS los correos HTML del demo ERP.

    Sustituye la macro `emailLayout` del tema `base`, que se limitaba a envolver
    el contenido en <html><body> sin ningun diseno. Reglas propias del correo
    electronico, que no son las de la web:

      - Todo el CSS va en el atributo `style`. Gmail, Outlook y Yahoo descartan
        las hojas de estilo y (en el caso de Gmail para moviles) tambien los
        bloques <style>, asi que aqui no hay ni <style> ni atributos `class`.
      - La maquetacion se hace con <table role="presentation"> anidadas: es lo
        unico que interpretan igual todos los clientes, incluido Outlook de
        escritorio, que renderiza con el motor de Word. `role="presentation"`
        evita que los lectores de pantalla las anuncien como tablas de datos.
      - Sin imagenes ni fuentes remotas: el logotipo es texto sobre un color de
        fondo, de modo que se ve igual aunque el cliente bloquee la descarga de
        imagenes (que es lo que hacen casi todos por defecto).
      - Ancho maximo de 600 px centrado: el estandar que cabe sin scroll
        horizontal en el panel de lectura de cualquier cliente.
      - Los colores son los mismos que los del tema de login (violeta profundo
        de marca sobre fondo claro), pero escritos como literales hexadecimales:
        las variables CSS no existen en el correo.

    Contrato hacia las plantillas hijas:

      - El cuerpo del mensaje se inyecta en <#nested>, dentro de la tarjeta
        blanca. La hija solo tiene que aportar sus parrafos.
      - Antes de invocar la macro, la hija puede definir el texto de vista previa
        que el cliente muestra junto al asunto en la bandeja de entrada:
            <#global erpPreheader = msg("...")>
        Si no lo define, simplemente no se emite.
-->
<#--
    Pila de fuentes del sistema, sin comillas a proposito: los nombres de familia
    con espacios son identificadores validos en CSS sin entrecomillar, y asi el
    valor no depende de como escape las comillas el cliente de correo.
-->
<#assign erpFont = "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif">

<#macro emailLayout>
<html lang="${locale.language}" dir="${(ltr)?then('ltr','rtl')}">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <#-- Este diseno esta pensado en claro; evitamos que el cliente lo invierta. -->
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${msg("erpEmailBrandName")}</title>
</head>
<body style="margin:0; padding:0; width:100%; background-color:#f2f1f8; color:#2b2843; font-family:${erpFont}; -webkit-font-smoothing:antialiased;">

<#-- Texto de vista previa: se muestra junto al asunto en la bandeja, pero no
     se ve al abrir el mensaje. `mso-hide:all` lo oculta tambien en Outlook. -->
<#if erpPreheader?? && erpPreheader?has_content>
    <div style="display:none; max-height:0; max-width:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#f2f1f8;">${erpPreheader}</div>
</#if>

<#-- Lienzo a todo el ancho: pinta el fondo de la pagina. Gmail descarta el
     estilo del <body>, por eso el color de fondo se repite aqui. -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse; background-color:#f2f1f8;">
    <tr>
        <td align="center" valign="top" style="padding:32px 16px 40px 16px;">

            <#-- Columna centrada de 600 px. El atributo width es para Outlook;
                 max-width hace que en el movil se reduzca sin desbordar. -->
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; border-collapse:collapse;">

                <#-- ----------------------------------------------------------
                     Cabecera de marca.
                     ---------------------------------------------------------- -->
                <tr>
                    <td style="background-color:#241155; border-radius:18px 18px 0 0; padding:26px 32px;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                            <tr>
                                <#-- Logotipo puramente tipografico: un cuadrado
                                     blanco con las siglas en violeta. -->
                                <td align="center" valign="middle" width="46" height="46" style="width:46px; height:46px; background-color:#ffffff; border-radius:13px; font-family:${erpFont}; font-size:14px; font-weight:bold; letter-spacing:0.08em; line-height:46px; mso-line-height-rule:exactly; color:#4c2fb0;">${msg("erpEmailBrandBadge")}</td>
                                <td valign="middle" style="padding-left:14px;">
                                    <div style="font-family:${erpFont}; font-size:19px; font-weight:bold; line-height:24px; color:#ffffff;">${msg("erpEmailBrandName")}</div>
                                    <div style="font-family:${erpFont}; font-size:13px; line-height:18px; color:#cfc4f5; padding-top:3px;">${msg("erpEmailBrandTagline")}</div>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>

                <#-- Filete de acento entre la cabecera y el cuerpo. -->
                <tr>
                    <td height="4" style="height:4px; line-height:4px; font-size:0; background-color:#6d4ae0;">&nbsp;</td>
                </tr>

                <#-- ----------------------------------------------------------
                     Cuerpo: lo aporta la plantilla hija.
                     ---------------------------------------------------------- -->
                <tr>
                    <td style="background-color:#ffffff; border-radius:0 0 18px 18px; padding:32px; font-family:${erpFont}; font-size:15px; line-height:24px; color:#2b2843;">
                        <#nested>
                    </td>
                </tr>

                <#-- ----------------------------------------------------------
                     Pie discreto, fuera de la tarjeta.
                     ---------------------------------------------------------- -->
                <tr>
                    <td align="center" style="padding:20px 24px 0 24px; text-align:center;">
                        <p style="margin:0 0 6px 0; font-family:${erpFont}; font-size:12px; line-height:18px; color:#56546e;">${msg("erpEmailFooterDemo")}</p>
                        <p style="margin:0; font-family:${erpFont}; font-size:12px; line-height:18px; color:#7a7791;">${msg("erpEmailFooterAuto")}</p>
                    </td>
                </tr>

            </table>

        </td>
    </tr>
</table>

</body>
</html>
</#macro>
