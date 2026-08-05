<#ftl output_format="plainText">
<#--
    Password recovery email (plain text version).

    This is the alternative seen by anyone reading in text mode, and the one many
    spam filters compare against the HTML version: it says exactly the same
    thing, through the same message keys, only without the layout.

    `output_format="plainText"` turns off FreeMarker's HTML escaping, so the link
    is printed verbatim and no `&` is turned into `&amp;`.
-->
<#assign clavisRecipientName = (user.firstName)!"">
<#if !clavisRecipientName?has_content>
<#assign clavisRecipientName = (user.username)!"">
</#if>
${msg("clavisEmailBrandName")}
${msg("clavisResetTitle")}

<#if clavisRecipientName?has_content>${msg("clavisEmailGreetingNamed", clavisRecipientName)}<#else>${msg("clavisEmailGreeting")}</#if>

${msg("clavisResetIntro", realmName)}

${msg("clavisResetTextCta")}

${link}

${msg("clavisResetExpiry", linkExpirationFormatter(linkExpiration))}

${msg("clavisResetIgnore")}

---
${msg("clavisEmailFooterDemo")}
${msg("clavisEmailFooterAuto")}
