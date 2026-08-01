<#--
    Confirmacion de cierre de sesion.

    Adaptada del logout-confirm.ftl de `base`. Se conservan intactos el formulario
    (action="${url.logoutConfirmAction}", method="POST"), el campo oculto
    session_code y el boton name="confirmLogout" id="kc-logout": de ellos depende
    que el logout funcione. Solo cambia el marcado.
-->
<#import "template.ftl" as layout>
<#global erpSubtitle = msg("erpLogoutSubtitle")>
<@layout.registrationLayout; section>
    <#if section = "header">
        ${msg("logoutConfirmTitle")}
    <#elseif section = "form">
        <div id="kc-logout-confirm" class="content-area">
            <p class="erp-card__subtitle">${msg("logoutConfirmHeader")}</p>

            <form class="form-actions" action="${url.logoutConfirmAction}" onsubmit="confirmLogout.disabled = true; return true;" method="POST">
                <input type="hidden" name="session_code" value="${logoutConfirm.code}">

                <div class="${properties.kcFormGroupClass!}">
                    <div id="kc-form-buttons">
                        <input tabindex="4"
                               class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}"
                               name="confirmLogout" id="kc-logout" type="submit" value="${msg("doLogout")}"/>
                    </div>
                </div>
            </form>

            <div id="kc-info-message">
                <#if logoutConfirm.skipLink>
                <#else>
                    <#if (client.baseUrl)?has_content>
                        <p>
                            <a class="${properties.kcButtonClass!} ${properties.kcButtonBlockClass!} erp-btn--ghost"
                               href="${client.baseUrl}">${kcSanitize(msg("backToApplication"))?no_esc}</a>
                        </p>
                    </#if>
                </#if>
            </div>
        </div>
    </#if>
</@layout.registrationLayout>
