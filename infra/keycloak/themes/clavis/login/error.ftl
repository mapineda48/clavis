<#--
    Generic error screen of the login flow.

    Adapted from the error.ftl of `base`: the original logic is preserved (the
    sanitised message and the link back to the application when there is no
    skipLink and the client declares a baseUrl). Only the markup changes.
-->
<#import "template.ftl" as layout>
<#global clavisSubtitle = msg("clavisErrorSubtitle")>
<@layout.registrationLayout displayMessage=false; section>
    <#if section = "header">
        ${kcSanitize(msg("errorTitle"))?no_esc}
    <#elseif section = "form">
        <div id="kc-error-message">
            <#if message?has_content>
                <div class="clavis-alert clavis-alert--error" role="alert">
                    <span class="clavis-alert__icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" focusable="false"><path d="M8 .8a7.2 7.2 0 1 0 0 14.4A7.2 7.2 0 0 0 8 .8m-.8 3.4h1.6v5H7.2zm0 6.4h1.6v1.6H7.2z" fill="currentColor"/></svg>
                    </span>
                    <span class="clavis-alert__text">${kcSanitize(message.summary)?no_esc}</span>
                </div>
            </#if>

            <#if skipLink??>
            <#else>
                <#if client?? && client.baseUrl?has_content>
                    <p>
                        <a id="backToApplication" class="${properties.kcButtonClass!} ${properties.kcButtonBlockClass!} clavis-btn--ghost"
                           href="${client.baseUrl}">${kcSanitize(msg("backToApplication"))?no_esc}</a>
                    </p>
                </#if>
            </#if>
        </div>
    </#if>
</@layout.registrationLayout>
