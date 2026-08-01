<#--
    Pantalla principal de inicio de sesion (usuario + contrasena).

    Adaptada del login.ftl del tema `base` de Keycloak 26.4. Se conserva TODO lo
    funcional del original:
      - el formulario id="kc-form-login" con action="${url.loginAction}" y method="post",
      - los campos name="username" / name="password" con sus id,
      - el input oculto name="credentialId",
      - el boton de mostrar/ocultar contrasena con data-password-toggle, aria-controls,
        data-icon-show/hide y data-label-show/hide (lo mueve passwordVisibility.js),
      - el import de passkeys.ftl y la llamada a <@passkeys.conditionalUIData />,
      - los condicionales de realm.* (password, rememberMe, resetPasswordAllowed,
        registrationAllowed, loginWithEmailAllowed, registrationEmailAsUsername),
      - el orden de tabulacion (1 = idioma, 2..7 = formulario, 8 = registro).
    Lo unico que cambia es el marcado: usa las clases del tema.
-->
<#import "template.ftl" as layout>
<#import "passkeys.ftl" as passkeys>
<#global erpSubtitle = msg("erpLoginSubtitle")>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=realm.password && realm.registrationAllowed && !registrationDisabled??; section>
    <#if section = "header">
        ${msg("loginAccountTitle")}
    <#elseif section = "form">
        <div id="kc-form">
            <div id="kc-form-wrapper">
                <#if realm.password>
                    <form id="kc-form-login" onsubmit="login.disabled = true; return true;" action="${url.loginAction}" method="post">

                        <#if !usernameHidden??>
                            <div class="${properties.kcFormGroupClass!}">
                                <label for="username" class="${properties.kcLabelClass!}"><#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if></label>

                                <input tabindex="2" id="username" class="${properties.kcInputClass!}" name="username"
                                       value="${(login.username!'')}" type="text"
                                       autofocus autocomplete="${(enableWebAuthnConditionalUI?has_content)?then('username webauthn', 'username')}"
                                       aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>"
                                       dir="ltr"
                                />

                                <#if messagesPerField.existsError('username','password')>
                                    <span id="input-error" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">
                                        ${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}
                                    </span>
                                </#if>
                            </div>
                        </#if>

                        <div class="${properties.kcFormGroupClass!}">
                            <label for="password" class="${properties.kcLabelClass!}">${msg("password")}</label>

                            <div class="${properties.kcInputGroup!}" dir="ltr">
                                <input tabindex="3" id="password" class="${properties.kcInputClass!}" name="password"
                                       type="password" autocomplete="current-password"
                                       aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>"
                                />
                                <#-- passwordVisibility.js reemplaza la clase COMPLETA del primer hijo
                                     de este boton, por eso cada data-icon-* es autosuficiente. -->
                                <button class="${properties.kcFormPasswordVisibilityButtonClass!}" type="button"
                                        aria-label="${msg('showPassword')}" aria-controls="password"
                                        data-password-toggle tabindex="4"
                                        data-icon-show="${properties.kcFormPasswordVisibilityIconShow!}"
                                        data-icon-hide="${properties.kcFormPasswordVisibilityIconHide!}"
                                        data-label-show="${msg('showPassword')}" data-label-hide="${msg('hidePassword')}">
                                    <i class="${properties.kcFormPasswordVisibilityIconShow!}" aria-hidden="true"></i>
                                </button>
                            </div>

                            <#if usernameHidden?? && messagesPerField.existsError('username','password')>
                                <span id="input-error" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">
                                    ${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}
                                </span>
                            </#if>
                        </div>

                        <div class="${properties.kcFormGroupClass!} ${properties.kcFormSettingClass!}">
                            <div id="kc-form-options">
                                <#if realm.rememberMe && !usernameHidden??>
                                    <label class="erp-checkbox" for="rememberMe">
                                        <#if login.rememberMe??>
                                            <input tabindex="5" id="rememberMe" name="rememberMe" type="checkbox" checked>
                                        <#else>
                                            <input tabindex="5" id="rememberMe" name="rememberMe" type="checkbox">
                                        </#if>
                                        <span>${msg("rememberMe")}</span>
                                    </label>
                                </#if>
                            </div>
                            <div class="${properties.kcFormOptionsWrapperClass!}">
                                <#if realm.resetPasswordAllowed>
                                    <span><a tabindex="6" class="erp-link" href="${url.loginResetCredentialsUrl}">${msg("doForgotPassword")}</a></span>
                                </#if>
                            </div>
                        </div>

                        <div id="kc-form-buttons" class="${properties.kcFormGroupClass!}">
                            <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth?has_content && auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
                            <input tabindex="7"
                                   class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}"
                                   name="login" id="kc-login" type="submit" value="${msg("doLogIn")}"/>
                        </div>
                    </form>
                </#if>
            </div>
        </div>
        <@passkeys.conditionalUIData />
        <script type="module" src="${url.resourcesPath}/js/passwordVisibility.js"></script>
    <#elseif section = "info">
        <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
            <div id="kc-registration-container">
                <div id="kc-registration">
                    <span>${msg("noAccount")} <a tabindex="8" class="erp-link" href="${url.registrationUrl}">${msg("doRegister")}</a></span>
                </div>
            </div>
        </#if>
    <#elseif section = "socialProviders">
        <#if realm.password && social?? && social.providers?has_content>
            <div id="kc-social-providers" class="${properties.kcFormSocialAccountSectionClass!}">
                <h2>${msg("identity-provider-login-label")}</h2>

                <ul class="${properties.kcFormSocialAccountListClass!}">
                    <#list social.providers as p>
                        <li>
                            <a data-once-link data-disabled-class="${properties.kcFormSocialAccountListButtonDisabledClass!}"
                               id="social-${p.alias}" class="${properties.kcFormSocialAccountListButtonClass!}"
                               type="button" href="${p.loginUrl}">
                                <#if p.iconClasses?has_content>
                                    <i class="${properties.kcCommonLogoIdP!} ${p.iconClasses!}" aria-hidden="true"></i>
                                    <span class="${properties.kcFormSocialAccountNameClass!} kc-social-icon-text">${p.displayName!}</span>
                                <#else>
                                    <span class="${properties.kcFormSocialAccountNameClass!}">${p.displayName!}</span>
                                </#if>
                            </a>
                        </li>
                    </#list>
                </ul>
            </div>
        </#if>
    </#if>
</@layout.registrationLayout>
