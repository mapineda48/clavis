<#--
    Paso 1 del flujo de recuperacion: pedir el usuario (o el correo) al que
    enviar el enlace para crear una contrasena nueva.

    Adaptada del login-reset-password.ftl del tema `base` de Keycloak 26.4. Se
    conserva TODO lo funcional del original:
      - el formulario id="kc-reset-password-form" con action="${url.loginAction}"
        y method="post",
      - el campo name="username" con value="${(auth.attemptedUsername!'')}", su
        aria-invalid y el bloque messagesPerField.existsError('username'),
      - la etiqueta condicional segun realm.loginWithEmailAllowed y
        realm.registrationEmailAsUsername,
      - el enlace a ${url.loginUrl} para volver al login,
      - la seccion "info" con emailInstruction / emailInstructionUsername segun
        realm.duplicateEmailsAllowed.
    Lo unico que cambia es el marcado: usa las clases del tema.

    Orden de tabulacion: 1 = idioma (lo fija template.ftl), 2..4 = formulario,
    9..11 = botones de la chuleta de usuarios. Aqui existe el campo #username,
    asi que erp-login.js los deja activos y sirven para rellenarlo.
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
        <#-- Nunca se confirma si la cuenta existe: el texto vale para ambos casos. -->
        <p>
            <#if realm.duplicateEmailsAllowed>
                ${msg("emailInstructionUsername")}
            <#else>
                ${msg("emailInstruction")}
            </#if>
        </p>
    </#if>
</@layout.registrationLayout>
