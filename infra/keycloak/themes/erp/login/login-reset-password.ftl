<#--
    Step 1 of the recovery flow: ask for the username (or email) the link to
    create a new password should be sent to.

    Adapted from the login-reset-password.ftl of Keycloak 26.4's `base` theme.
    EVERYTHING functional in the original is preserved:
      - the form id="kc-reset-password-form" with action="${url.loginAction}"
        and method="post",
      - the name="username" field with value="${(auth.attemptedUsername!'')}", its
        aria-invalid and the messagesPerField.existsError('username') block,
      - the conditional label driven by realm.loginWithEmailAllowed and
        realm.registrationEmailAsUsername,
      - the link to ${url.loginUrl} to go back to the login screen,
      - the "info" section with emailInstruction / emailInstructionUsername
        depending on realm.duplicateEmailsAllowed.
    Only the markup changes: it uses the theme classes.

    Tab order: 1 = language (set by template.ftl), 2..4 = form, 9..11 = buttons of
    the demo user cheat sheet. The #username field exists on this screen, so
    erp-login.js leaves those buttons enabled and they do fill it in.
-->
<#import "template.ftl" as layout>
<#global erpSubtitle = msg("erpResetSubtitle")>
<@layout.registrationLayout displayInfo=true displayMessage=!messagesPerField.existsError('username'); section>
    <#if section = "header">
        ${msg("emailForgotTitle")}
    <#elseif section = "form">
        <form id="kc-reset-password-form" action="${url.loginAction}" method="post">

            <div class="${properties.kcFormGroupClass!}">
                <label for="username" class="${properties.kcLabelClass!}"><#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if></label>

                <input tabindex="2" type="text" id="username" name="username" class="${properties.kcInputClass!}"
                       value="${(auth.attemptedUsername!'')}"
                       autofocus autocomplete="username"
                       aria-invalid="<#if messagesPerField.existsError('username')>true</#if>"
                       dir="ltr"
                />

                <#if messagesPerField.existsError('username')>
                    <span id="input-error-username" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">
                        ${kcSanitize(messagesPerField.get('username'))?no_esc}
                    </span>
                </#if>
            </div>

            <div id="kc-form-buttons" class="${properties.kcFormButtonsClass!}">
                <input tabindex="3"
                       class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}"
                       type="submit" value="${msg("doSubmit")}"/>
            </div>

            <div id="kc-form-options" class="${properties.kcFormOptionsClass!}">
                <span><a tabindex="4" class="erp-link" href="${url.loginUrl}">${kcSanitize(msg("backToLogin"))?no_esc}</a></span>
            </div>
        </form>
    <#elseif section = "info">
        <#-- We never confirm whether the account exists: the wording fits both cases. -->
        <p>
            <#if realm.duplicateEmailsAllowed>
                ${msg("emailInstructionUsername")}
            <#else>
                ${msg("emailInstruction")}
            </#if>
        </p>
    </#if>
</@layout.registrationLayout>
