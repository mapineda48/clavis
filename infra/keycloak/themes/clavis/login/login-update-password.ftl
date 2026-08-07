<#--
    Step 2 of the recovery flow: set the new password.

    It is served both by the link in the recovery email and by the UPDATE_PASSWORD
    required action, which is what the isAppInitiatedAction?? branch is for.

    Adapted from the login-update-password.ftl of Keycloak 26.4's `base` theme.
    EVERYTHING functional in the original is preserved:
      - the form id="kc-passwd-update-form" with action="${url.loginAction}"
        and method="post",
      - the name="password-new" and name="password-confirm" fields with their ids
        and their messagesPerField blocks,
      - the show/hide buttons with data-password-toggle, aria-controls,
        data-icon-show/hide and data-label-show/hide (passwordVisibility.js drives them),
      - the password-commons.ftl import and the logoutOtherSessions call,
      - the isAppInitiatedAction?? branch with its name="cancel-aia" button.
    Only the markup changes: it uses the theme classes.

    No tabindex values here, on purpose: the logoutOtherSessions checkbox is
    rendered by a base-theme macro that takes no tabindex, and numbering
    everything else would push it to the end of the sequence. With everything at
    0 the order is document order, which is already the right one on this screen.
-->
<#import "template.ftl" as layout>
<#import "password-commons.ftl" as passwordCommons>
<#global clavisSubtitle = msg("clavisUpdatePasswordSubtitle")>
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
                    <#-- passwordVisibility.js replaces the ENTIRE class of this button's
                         first child, hence every data-icon-* is self-contained. -->
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

            <#-- Base-theme macro: it emits <div class="checkbox"><label>...; the theme
                 CSS covers that shape as well as our own (.clavis-checkbox). -->
            <div class="${properties.kcFormGroupClass!}">
                <@passwordCommons.logoutOtherSessions/>
            </div>

            <#-- The submit button comes first so that pressing Enter inside a field
                 saves the password instead of cancelling the action. -->
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
