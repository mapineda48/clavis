<#--
    Password recovery email (HTML version).

    What Keycloak puts in the model for this template:
      - link                              single-use link to the form
      - linkExpiration                    expiration in minutes (a number)
      - linkExpirationFormatter(minutes)  that same expiration already worded
                                          ("30 minutes", "1 hour"...)
      - realmName                         display name of the realm
      - user                              profile of the recipient

    The `base` theme just dumped `passwordResetBodyHtml` as a lone paragraph.
    Here the message is composed piece by piece inside `emailLayout`, and every
    string comes from an `clavis`-prefixed key of our own (declared in
    email/messages/messages_en.properties and messages_es.properties): there is
    not a single hard-coded string in the template.
-->
<#import "template.ftl" as layout>

<#-- Same font stack as the layout: in email the family has to be repeated on
     every text element, because several clients do not inherit it. -->
<#assign clavisFont = "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif">

<#-- Personalised greeting when we know the recipient's name. The parentheses
     with `!` cover both an empty attribute and a model without `user`. -->
<#assign clavisRecipientName = (user.firstName)!"">
<#if !clavisRecipientName?has_content>
    <#assign clavisRecipientName = (user.username)!"">
</#if>

<#-- Preview text shown in the inbox (see template.ftl). -->
<#global clavisPreheader = msg("clavisResetPreheader")>

<@layout.emailLayout>
    <h1 style="margin:0 0 16px 0; font-family:${clavisFont}; font-size:22px; font-weight:bold; line-height:28px; color:#1a1830;">${msg("clavisResetTitle")}</h1>

    <p style="margin:0 0 12px 0; font-family:${clavisFont}; font-size:15px; line-height:24px; color:#2b2843;"><#if clavisRecipientName?has_content>${msg("clavisEmailGreetingNamed", clavisRecipientName)}<#else>${msg("clavisEmailGreeting")}</#if></p>

    <p style="margin:0 0 12px 0; font-family:${clavisFont}; font-size:15px; line-height:24px; color:#2b2843;">${msg("clavisResetIntro", realmName)}</p>

    <p style="margin:0 0 24px 0; font-family:${clavisFont}; font-size:15px; line-height:24px; color:#2b2843;">${msg("clavisResetCta")}</p>

    <#-- Client-proof button: the background colour goes on the <td> (with the
         bgcolor attribute for Outlook) and on the <a> as well, which is what
         takes the click and fills the cell thanks to display:inline-block. -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate; margin:0 0 24px 0;">
        <tr>
            <td align="center" bgcolor="#4c2fb0" style="background-color:#4c2fb0; border-radius:12px;">
                <a href="${link}" target="_blank" style="display:inline-block; padding:14px 30px; border:1px solid #4c2fb0; border-radius:12px; background-color:#4c2fb0; font-family:${clavisFont}; font-size:16px; font-weight:bold; line-height:20px; color:#ffffff; text-decoration:none;">${msg("clavisResetButton")}</a>
            </td>
        </tr>
    </table>

    <#-- Highlighted expiration notice. -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse; margin:0 0 20px 0;">
        <tr>
            <td style="background-color:#f3efff; border-left:4px solid #6d4ae0; border-radius:10px; padding:12px 16px; font-family:${clavisFont}; font-size:14px; line-height:22px; color:#3a3757;">${msg("clavisResetExpiry", linkExpirationFormatter(linkExpiration))}</td>
        </tr>
    </table>

    <p style="margin:0; font-family:${clavisFont}; font-size:14px; line-height:22px; color:#56546e;">${msg("clavisResetIgnore")}</p>

    <#-- Separator: a 1 px <div> is more reliable than <hr> in Outlook. -->
    <div style="height:1px; line-height:1px; font-size:0; background-color:#e4e0f2; margin:24px 0;">&nbsp;</div>

    <#-- Fallback for clients that will not let the button be clicked. -->
    <p style="margin:0 0 8px 0; font-family:${clavisFont}; font-size:13px; line-height:20px; color:#56546e;">${msg("clavisResetFallback")}</p>
    <p style="margin:0; font-family:${clavisFont}; font-size:13px; line-height:20px; word-break:break-all; overflow-wrap:anywhere;"><a href="${link}" target="_blank" style="color:#4c2fb0; text-decoration:underline;">${link}</a></p>
</@layout.emailLayout>
