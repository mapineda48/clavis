<#ftl output_format="plainText">
<#--
    Correo de recuperacion de contrasena (version en texto plano).

    Es la alternativa que ve quien tiene el cliente en modo texto y la que muchos
    filtros antispam comparan con la version HTML: dice exactamente lo mismo, con
    las mismas claves de mensaje, pero sin maqueta.

    `output_format="plainText"` desactiva el escapado HTML de FreeMarker, asi que
    el enlace se imprime tal cual y no se convierte ningun `&` en `&amp;`.
-->
<#assign erpRecipientName = (user.firstName)!"">
<#if !erpRecipientName?has_content>
<#assign erpRecipientName = (user.username)!"">
</#if>
${msg("erpEmailBrandName")}
${msg("erpResetTitle")}

<#if erpRecipientName?has_content>${msg("erpEmailGreetingNamed", erpRecipientName)}<#else>${msg("erpEmailGreeting")}</#if>

${msg("erpResetIntro", realmName)}

${msg("erpResetTextCta")}

${link}

${msg("erpResetExpiry", linkExpirationFormatter(linkExpiration))}

${msg("erpResetIgnore")}

---
${msg("erpEmailFooterDemo")}
${msg("erpEmailFooterAuto")}
