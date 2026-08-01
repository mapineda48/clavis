<#--
    Correo de recuperacion de contrasena (version HTML).

    Datos que Keycloak deja en el modelo para esta plantilla:
      - link                              enlace de un solo uso hacia el formulario
      - linkExpiration                    caducidad en minutos (numero)
      - linkExpirationFormatter(minutos)  esa misma caducidad ya redactada
                                          ("30 minutos", "1 hora"...)
      - realmName                         nombre visible del realm
      - user                              perfil del destinatario

    El tema `base` se limitaba a volcar `passwordResetBodyHtml` como un parrafo
    suelto. Aqui componemos el mensaje pieza a pieza dentro de `emailLayout`, y
    todos los textos salen de claves propias con prefijo `erp` (definidas en
    email/messages/messages_es.properties y messages_en.properties): en la
    plantilla no hay ni una cadena incrustada.
-->
<#import "template.ftl" as layout>

<#-- Misma pila de fuentes que la maqueta: en el correo hay que repetir la
     familia en cada elemento de texto, porque varios clientes no la heredan. -->
<#assign erpFont = "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif">

<#-- Saludo personalizado si sabemos como se llama el destinatario. Los
     parentesis con `!` cubren tanto que el atributo venga vacio como que el
     modelo no traiga `user`. -->
<#assign erpRecipientName = (user.firstName)!"">
<#if !erpRecipientName?has_content>
    <#assign erpRecipientName = (user.username)!"">
</#if>

<#-- Texto de vista previa en la bandeja de entrada (ver template.ftl). -->
<#global erpPreheader = msg("erpResetPreheader")>

<@layout.emailLayout>
    <h1 style="margin:0 0 16px 0; font-family:${erpFont}; font-size:22px; font-weight:bold; line-height:28px; color:#1a1830;">${msg("erpResetTitle")}</h1>

    <p style="margin:0 0 12px 0; font-family:${erpFont}; font-size:15px; line-height:24px; color:#2b2843;"><#if erpRecipientName?has_content>${msg("erpEmailGreetingNamed", erpRecipientName)}<#else>${msg("erpEmailGreeting")}</#if></p>

    <p style="margin:0 0 12px 0; font-family:${erpFont}; font-size:15px; line-height:24px; color:#2b2843;">${msg("erpResetIntro", realmName)}</p>

    <p style="margin:0 0 24px 0; font-family:${erpFont}; font-size:15px; line-height:24px; color:#2b2843;">${msg("erpResetCta")}</p>

    <#-- Boton a prueba de clientes: el color de fondo va en el <td> (con el
         atributo bgcolor para Outlook) y tambien en el <a>, que es quien recibe
         el clic y ocupa toda la celda gracias a display:inline-block. -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate; margin:0 0 24px 0;">
        <tr>
            <td align="center" bgcolor="#4c2fb0" style="background-color:#4c2fb0; border-radius:12px;">
                <a href="${link}" target="_blank" style="display:inline-block; padding:14px 30px; border:1px solid #4c2fb0; border-radius:12px; background-color:#4c2fb0; font-family:${erpFont}; font-size:16px; font-weight:bold; line-height:20px; color:#ffffff; text-decoration:none;">${msg("erpResetButton")}</a>
            </td>
        </tr>
    </table>

    <#-- Aviso de caducidad destacado. -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse; margin:0 0 20px 0;">
        <tr>
            <td style="background-color:#f3efff; border-left:4px solid #6d4ae0; border-radius:10px; padding:12px 16px; font-family:${erpFont}; font-size:14px; line-height:22px; color:#3a3757;">${msg("erpResetExpiry", linkExpirationFormatter(linkExpiration))}</td>
        </tr>
    </table>

    <p style="margin:0; font-family:${erpFont}; font-size:14px; line-height:22px; color:#56546e;">${msg("erpResetIgnore")}</p>

    <#-- Separador: un <div> de 1 px es mas fiable que <hr> en Outlook. -->
    <div style="height:1px; line-height:1px; font-size:0; background-color:#e4e0f2; margin:24px 0;">&nbsp;</div>

    <#-- Respaldo para los clientes que no dejan pulsar el boton. -->
    <p style="margin:0 0 8px 0; font-family:${erpFont}; font-size:13px; line-height:20px; color:#56546e;">${msg("erpResetFallback")}</p>
    <p style="margin:0; font-family:${erpFont}; font-size:13px; line-height:20px; word-break:break-all; overflow-wrap:anywhere;"><a href="${link}" target="_blank" style="color:#4c2fb0; text-decoration:underline;">${link}</a></p>
</@layout.emailLayout>
