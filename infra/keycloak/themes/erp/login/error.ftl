<#--
    Pantalla de error generico del flujo de login.

    Adaptada del error.ftl de `base`: se conserva la logica original (el mensaje
    saneado y el enlace de vuelta a la aplicacion cuando no hay skipLink y el
    cliente declara baseUrl). Solo cambia el marcado.
-->
<#import "template.ftl" as layout>
<#global erpSubtitle = msg("erpErrorSubtitle")>
<@layout.registrationLayout displayMessage=false; section>
    <#if section = "header">
        ${kcSanitize(msg("errorTitle"))?no_esc}
    <#elseif section = "form">
        <div id="kc-error-message">
            <#if message?has_content>
                <div class="erp-alert erp-alert--error" role="alert">
                    <span class="erp-alert__icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" focusable="false"><path d="M8 .8a7.2 7.2 0 1 0 0 14.4A7.2 7.2 0 0 0 8 .8m-.8 3.4h1.6v5H7.2zm0 6.4h1.6v1.6H7.2z" fill="currentColor"/></svg>
                    </span>
                    <span class="erp-alert__text">${kcSanitize(message.summary)?no_esc}</span>
                </div>
            </#if>

            <#if skipLink??>
            <#else>
                <#if client?? && client.baseUrl?has_content>
                    <p>
                        <a id="backToApplication" class="${properties.kcButtonClass!} ${properties.kcButtonBlockClass!} erp-btn--ghost"
                           href="${client.baseUrl}">${kcSanitize(msg("backToApplication"))?no_esc}</a>
                    </p>
                </#if>
            </#if>
        </div>
    </#if>
</@layout.registrationLayout>
