<#ftl output_format="plainText">
<#--
    Password recovery email (plain text version).

    This is the alternative seen by anyone reading in text mode, and the one many
    spam filters compare against the HTML version: it says exactly the same
    thing, through the same message keys, only without the layout.

    `output_format="plainText"` turns off FreeMarker's HTML escaping, so the link
    is printed verbatim and no `&` is turned into `&amp;`.
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
