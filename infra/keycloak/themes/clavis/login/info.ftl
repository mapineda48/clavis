<#--
    Generic informational screen (email sent, action completed, and so on).

    Adapted from the info.ftl of `base`: the conditional header (messageHeader),
    the requiredActions list and the pageRedirectUri -> actionUri ->
    client.baseUrl link cascade are all preserved. Only the markup changes.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
    <#if section = "header">
        <#if messageHeader??>
            ${kcSanitize(msg("${messageHeader}"))?no_esc}
        <#elseif message?has_content>
            ${message.summary}
        </#if>
    <#elseif section = "form">
        <div id="kc-info-message">
            <#if message?has_content>
                <div class="clavis-alert clavis-alert--info" role="status">
                    <span class="clavis-alert__icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" focusable="false"><path d="M8 .8a7.2 7.2 0 1 0 0 14.4A7.2 7.2 0 0 0 8 .8m-.8 2.8h1.6v1.6H7.2zm0 3.2h1.6v5.4H7.2z" fill="currentColor"/></svg>
                    </span>
                    <span class="clavis-alert__text">${message.summary}<#if requiredActions??><#list requiredActions>: <b><#items as reqActionItem>${kcSanitize(msg("requiredAction.${reqActionItem}"))?no_esc}<#sep>, </#items></b></#list></#if></span>
                </div>
            </#if>

            <#if skipLink??>
            <#else>
                <#if pageRedirectUri?has_content>
                    <p><a class="${properties.kcButtonClass!} ${properties.kcButtonBlockClass!} clavis-btn--ghost" href="${pageRedirectUri}">${kcSanitize(msg("backToApplication"))?no_esc}</a></p>
                <#elseif actionUri?has_content>
                    <p><a class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}" href="${actionUri}">${kcSanitize(msg("proceedWithAction"))?no_esc}</a></p>
                <#elseif (client.baseUrl)?has_content>
                    <p><a class="${properties.kcButtonClass!} ${properties.kcButtonBlockClass!} clavis-btn--ghost" href="${client.baseUrl}">${kcSanitize(msg("backToApplication"))?no_esc}</a></p>
                </#if>
            </#if>
        </div>
    </#if>
</@layout.registrationLayout>
