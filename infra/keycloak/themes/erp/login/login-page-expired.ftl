<#--
    "The page has expired" screen.

    Adapted from the login-page-expired.ftl of `base`. Both links keep their
    original ids (loginRestartLink -> url.loginRestartFlowUrl and
    loginContinueLink -> url.loginAction); only the markup changes.
-->
<#import "template.ftl" as layout>
<#global erpSubtitle = msg("erpPageExpiredSubtitle")>
<@layout.registrationLayout; section>
    <#if section = "header">
        ${msg("pageExpiredTitle")}
    <#elseif section = "form">
        <div id="kc-page-expired">
            <div class="erp-alert erp-alert--warning" role="alert">
                <span class="erp-alert__icon" aria-hidden="true">
                    <svg viewBox="0 0 16 16" focusable="false"><path d="M8 1.3 15.4 14.2H.6zM7.2 6v4.2h1.6V6zm0 5.4v1.6h1.6v-1.6z" fill="currentColor"/></svg>
                </span>
                <span class="erp-alert__text">${msg("erpPageExpiredHint")}</span>
            </div>

            <p id="instruction1" class="erp-card__subtitle">
                ${msg("pageExpiredMsg1")}
                <a id="loginRestartLink" class="erp-link" href="${url.loginRestartFlowUrl}">${msg("doClickHere")}</a>.<br/>
                ${msg("pageExpiredMsg2")}
                <a id="loginContinueLink" class="erp-link" href="${url.loginAction}">${msg("doClickHere")}</a>.
            </p>

            <div class="${properties.kcFormGroupClass!}">
                <a class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}"
                   href="${url.loginRestartFlowUrl}">${msg("erpRestartLogin")}</a>
            </div>
        </div>
    </#if>
</@layout.registrationLayout>
