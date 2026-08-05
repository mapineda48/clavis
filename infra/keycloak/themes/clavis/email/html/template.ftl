<#--
    Layout shared by EVERY HTML email of the Clavis demo.

    It replaces the `emailLayout` macro of the `base` theme, which merely wrapped
    the content in <html><body> with no design at all. Email has its own rules,
    and they are not the web ones:

      - All the CSS lives in the `style` attribute. Gmail, Outlook and Yahoo drop
        stylesheets and (in the case of Gmail on mobile) <style> blocks as well,
        so there is neither a <style> element nor a `class` attribute here.
      - Layout is done with nested <table role="presentation">: that is the only
        thing every client interprets the same way, including desktop Outlook,
        which renders with the Word engine. `role="presentation"` keeps screen
        readers from announcing them as data tables.
      - No remote images or fonts: the logo is text on a background colour, so it
        looks the same even when the client blocks image downloads (which is what
        almost all of them do by default).
      - A centred 600 px maximum width: the standard that fits without horizontal
        scrolling in any client's reading pane.
      - The colours are the same as the login theme (deep brand violet on a light
        background), but written as hex literals: CSS variables do not exist in
        email.

    Contract for the child templates:

      - The body of the message is injected at <#nested>, inside the white card.
        The child only has to supply its paragraphs.
      - Before calling the macro, a child may define the preview text the client
        shows next to the subject in the inbox:
            <#global clavisPreheader = msg("...")>
        If it does not, nothing is emitted.
-->
<#--
    System font stack, deliberately unquoted: family names containing spaces are
    valid CSS identifiers without quotes, so the value does not depend on how the
    mail client escapes quotation marks.
-->
<#assign clavisFont = "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif">

<#macro emailLayout>
<html lang="${locale.language}" dir="${(ltr)?then('ltr','rtl')}">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <#-- This design is built for light mode; stop the client from inverting it. -->
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${msg("clavisEmailBrandName")}</title>
</head>
<body style="margin:0; padding:0; width:100%; background-color:#f2f1f8; color:#2b2843; font-family:${clavisFont}; -webkit-font-smoothing:antialiased;">

<#-- Preview text: shown next to the subject in the inbox, but invisible once the
     message is open. `mso-hide:all` hides it in Outlook too. -->
<#if clavisPreheader?? && clavisPreheader?has_content>
    <div style="display:none; max-height:0; max-width:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#f2f1f8;">${clavisPreheader}</div>
</#if>

<#-- Full-width canvas: it paints the page background. Gmail discards the <body>
     style, which is why the background colour is repeated here. -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse; background-color:#f2f1f8;">
    <tr>
        <td align="center" valign="top" style="padding:32px 16px 40px 16px;">

            <#-- Centred 600 px column. The width attribute is for Outlook;
                 max-width is what lets it shrink on mobile without overflowing. -->
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; border-collapse:collapse;">

                <#-- ----------------------------------------------------------
                     Brand header.
                     ---------------------------------------------------------- -->
                <tr>
                    <td style="background-color:#241155; border-radius:18px 18px 0 0; padding:26px 32px;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                            <tr>
                                <#-- Purely typographic logo: a white square with
                                     the initials in violet. -->
                                <td align="center" valign="middle" width="46" height="46" style="width:46px; height:46px; background-color:#ffffff; border-radius:13px; font-family:${clavisFont}; font-size:14px; font-weight:bold; letter-spacing:0.08em; line-height:46px; mso-line-height-rule:exactly; color:#4c2fb0;">${msg("clavisEmailBrandBadge")}</td>
                                <td valign="middle" style="padding-left:14px;">
                                    <div style="font-family:${clavisFont}; font-size:19px; font-weight:bold; line-height:24px; color:#ffffff;">${msg("clavisEmailBrandName")}</div>
                                    <div style="font-family:${clavisFont}; font-size:13px; line-height:18px; color:#cfc4f5; padding-top:3px;">${msg("clavisEmailBrandTagline")}</div>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>

                <#-- Accent rule between the header and the body. -->
                <tr>
                    <td height="4" style="height:4px; line-height:4px; font-size:0; background-color:#6d4ae0;">&nbsp;</td>
                </tr>

                <#-- ----------------------------------------------------------
                     Body: supplied by the child template.
                     ---------------------------------------------------------- -->
                <tr>
                    <td style="background-color:#ffffff; border-radius:0 0 18px 18px; padding:32px; font-family:${clavisFont}; font-size:15px; line-height:24px; color:#2b2843;">
                        <#nested>
                    </td>
                </tr>

                <#-- ----------------------------------------------------------
                     Quiet footer, outside the card.
                     ---------------------------------------------------------- -->
                <tr>
                    <td align="center" style="padding:20px 24px 0 24px; text-align:center;">
                        <p style="margin:0 0 6px 0; font-family:${clavisFont}; font-size:12px; line-height:18px; color:#56546e;">${msg("clavisEmailFooterDemo")}</p>
                        <p style="margin:0; font-family:${clavisFont}; font-size:12px; line-height:18px; color:#7a7791;">${msg("clavisEmailFooterAuto")}</p>
                    </td>
                </tr>

            </table>

        </td>
    </tr>
</table>

</body>
</html>
</#macro>
