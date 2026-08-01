<#--
    Paso 2 del flujo de recuperacion: fijar la contrasena nueva.

    La sirve tanto el enlace del correo de recuperacion como la accion requerida
    UPDATE_PASSWORD, de ahi la rama isAppInitiatedAction??.

    Adaptada del login-update-password.ftl del tema `base` de Keycloak 26.4. Se
    conserva TODO lo funcional del original:
      - el formulario id="kc-passwd-update-form" con action="${url.loginAction}"
        y method="post",
      - los campos name="password-new" y name="password-confirm" con sus id y sus
        bloques messagesPerField,
      - los botones de mostrar/ocultar con data-password-toggle, aria-controls,
        data-icon-show/hide y data-label-show/hide (los mueve passwordVisibility.js),
      - el import de password-commons.ftl y la llamada a logoutOtherSessions,
      - la rama isAppInitiatedAction?? con su boton name="cancel-aia".
    Lo unico que cambia es el marcado: usa las clases del tema.

    Sin tabindex propios a proposito: la casilla de logoutOtherSessions la pinta
    una macro del tema base que no admite tabindex, y numerar el resto la echaria
    al final del recorrido. Con todo a 0 el orden es el del documento, que aqui ya
    es el correcto. Los botones de la chuleta de usuarios (tabindex 9..11) quedan
    desactivados por erp-login.js: en esta pantalla no hay campo #username.
-->
<#import "template.ftl" as layout>
<#import "password-commons.ftl" as passwordCommons>
<#global erpSubtitle = msg("erpUpdatePasswordSubtitle")>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('password','password-confirm'); section>
    <#if section = "header">
        ${msg("updatePasswordTitle")}
    <#elseif section = "form">
        <form id="kc-passwd-update-form" onsubmit="login.disabled = true; return true;" action="${url.loginAction}" method="post">

            <div class="${properties.kcFormGroupClass!}">
                <label for="password-new" class="${properties.kcLabelClass!}">${msg("passwordNew")}</label>

                <div class="${properties.kcInputGroup!}" dir="ltr">
                    <input type="password" id="password-new" name="password-new" class="${properties.kcInputClass!}"
                           autofocus autocomplete="new-password"
                           aria-invalid="<#if messagesPerField.existsError('password','password-confirm')>true</#if>"
                    />
                    <#-- passwordVisibility.js reemplaza la clase COMPLETA del primer hijo
                         de este boton, por eso cada data-icon-* es autosuficiente. -->
                    <button class="${properties.kcFormPasswordVisibilityButtonClass!}" type="button"
                            aria-label="${msg('showPassword')}" aria-controls="password-new"
                            data-password-toggle
                            data-icon-show="${properties.kcFormPasswordVisibilityIconShow!}"
                            data-icon-hide="${properties.kcFormPasswordVisibilityIconHide!}"
                            data-label-show="${msg('showPassword')}" data-label-hide="${msg('hidePassword')}">
                        <i class="${properties.kcFormPasswordVisibilityIconShow!}" aria-hidden="true"></i>
                    </button>
                </div>

                <#if messagesPerField.existsError('password')>
                    <span id="input-error-password" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">
                        ${kcSanitize(messagesPerField.get('password'))?no_esc}
                    </span>
                </#if>
            </div>

            <div class="${properties.kcFormGroupClass!}">
                <label for="password-confirm" class="${properties.kcLabelClass!}">${msg("passwordConfirm")}</label>

                <div class="${properties.kcInputGroup!}" dir="ltr">
                    <input type="password" id="password-confirm" name="password-confirm" class="${properties.kcInputClass!}"
                           autocomplete="new-password"
                           aria-invalid="<#if messagesPerField.existsError('password-confirm')>true</#if>"
                    />
                    <button class="${properties.kcFormPasswordVisibilityButtonClass!}" type="button"
                            aria-label="${msg('showPassword')}" aria-controls="password-confirm"
                            data-password-toggle
                            data-icon-show="${properties.kcFormPasswordVisibilityIconShow!}"
                            data-icon-hide="${properties.kcFormPasswordVisibilityIconHide!}"
                            data-label-show="${msg('showPassword')}" data-label-hide="${msg('hidePassword')}">
                        <i class="${properties.kcFormPasswordVisibilityIconShow!}" aria-hidden="true"></i>
                    </button>
                </div>

                <#if messagesPerField.existsError('password-confirm')>
                    <span id="input-error-password-confirm" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">
                        ${kcSanitize(messagesPerField.get('password-confirm'))?no_esc}
                    </span>
                </#if>
            </div>

            <#-- Macro del tema base: emite <div class="checkbox"><label>...; el CSS del
                 tema cubre esa forma ademas de la nuestra (.erp-checkbox). -->
            <div class="${properties.kcFormGroupClass!}">
                <@passwordCommons.logoutOtherSessions/>
            </div>

            <#-- El submit va primero para que Enter dentro de los campos guarde la
                 contrasena y no cancele la accion. -->
            <div id="kc-form-buttons" class="${properties.kcFormButtonsClass!}">
                <input name="login"
                       class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}"
                       type="submit" value="${msg("doSubmit")}"/>
            </div>

            <#if isAppInitiatedAction??>
                <div class="${properties.kcFormGroupClass!}">
                    <button class="${properties.kcButtonDefaultClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}"
                            type="submit" name="cancel-aia" value="true">${msg("doCancel")}</button>
                </div>
            </#if>
        </form>
        <script type="module" src="${url.resourcesPath}/js/passwordVisibility.js"></script>
    </#if>
</@layout.registrationLayout>
