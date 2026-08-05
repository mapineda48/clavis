<#--
    Sign-out confirmation.

    Adapted from the logout-confirm.ftl of `base`. The form
    (action="${url.logoutConfirmAction}", method="POST"), the hidden session_code
    field and the name="confirmLogout" id="kc-logout" button are untouched:
    logging out depends on them. Only the markup changes.
-->
<#import "template.ftl" as layout>
<#global clavisSubtitle = msg("clavisLogoutSubtitle")>
<@layout.registrationLayout; section>
    <#if section = "header">
        ${msg("logoutConfirmTitle")}
    <#elseif section = "form">
        <div id="kc-logout-confirm" class="content-area">
            <p class="clavis-card__subtitle">${msg("logoutConfirmHeader")}</p>

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
                            <a class="${properties.kcButtonClass!} ${properties.kcButtonBlockClass!} clavis-btn--ghost"
                               href="${client.baseUrl}">${kcSanitize(msg("backToApplication"))?no_esc}</a>
                        </p>
                    </#if>
                </#if>
            </div>
        </div>
    </#if>
</@layout.registrationLayout>
