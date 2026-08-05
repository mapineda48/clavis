<#--
    "The page has expired" screen.

    Adapted from the login-page-expired.ftl of `base`. Both links keep their
    original ids (loginRestartLink -> url.loginRestartFlowUrl and
    loginContinueLink -> url.loginAction); only the markup changes.
-->
<#import "template.ftl" as layout>
<#global clavisSubtitle = msg("clavisPageExpiredSubtitle")>
<@layout.registrationLayout; section>
    <#if section = "header">
        ${msg("pageExpiredTitle")}
    <#elseif section = "form">
        <div id="kc-page-expired">
            <div class="clavis-alert clavis-alert--warning" role="alert">
                <span class="clavis-alert__icon" aria-hidden="true">
                    <svg viewBox="0 0 16 16" focusable="false"><path d="M8 1.3 15.4 14.2H.6zM7.2 6v4.2h1.6V6zm0 5.4v1.6h1.6v-1.6z" fill="currentColor"/></svg>
                </span>
                <span class="clavis-alert__text">${msg("clavisPageExpiredHint")}</span>
            </div>

            <p id="instruction1" class="clavis-card__subtitle">
                ${msg("pageExpiredMsg1")}
                <a id="loginRestartLink" class="clavis-link" href="${url.loginRestartFlowUrl}">${msg("doClickHere")}</a>.<br/>
                ${msg("pageExpiredMsg2")}
                <a id="loginContinueLink" class="clavis-link" href="${url.loginAction}">${msg("doClickHere")}</a>.
            </p>

            <div class="${properties.kcFormGroupClass!}">
                <a class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}"
                   href="${url.loginRestartFlowUrl}">${msg("clavisRestartLogin")}</a>
            </div>
        </div>
    </#if>
</@layout.registrationLayout>
