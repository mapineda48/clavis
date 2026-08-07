<#--
    Layout shared by every login screen of the Clavis demo.

    Derived from the template.ftl of Keycloak 26.4's `base` theme, whose contract
    it keeps to the letter:
      - the macro signature (bodyClass, displayInfo, displayMessage, displayRequiredFields),
      - the five nested sections and their order:
        "header", "show-username", "form", "socialProviders", "info",
      - every <script> in the <head> (the rfc4648 importmap, menu-button-links,
        authChecker/startSessionPolling, the data-once-link handler and the
        conditional authenticationSession block) and the <link rel="icon">.

    Only the HTML is different: a split screen with the brand panel on the left
    and the form card on the right.

    Child templates may declare a subtitle for the card with:
        <#global clavisSubtitle = msg("...")>
    before calling the macro. If they do not, nothing is rendered there.
-->
<#import "footer.ftl" as loginFooter>
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html class="${properties.kcHtmlClass!}" lang="${lang}"<#if realm.internationalizationEnabled> dir="${(locale.rtl)?then('rtl','ltr')}"</#if>>

<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />

    <#if properties.meta?has_content>
        <#list properties.meta?split(' ') as meta>
            <meta name="${meta?split('==')[0]}" content="${meta?split('==')[1]}"/>
        </#list>
    </#if>
    <title>${msg("loginTitle",(realm.displayName!''))}</title>
    <#--
      Inline, so there is no request to make and nothing to 404 on. The previous
      href pointed at resources/img/favicon.ico, a directory this theme never
      had, so every login page load logged a 404 in the browser console.
      Same padlock as the brand mark on the panel.
    -->
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%234f46e5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='11' width='18' height='11' rx='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 10 0v4'/%3E%3C/svg%3E" />
    <#if properties.stylesCommon?has_content>
        <#list properties.stylesCommon?split(' ') as style>
            <link href="${url.resourcesCommonPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#-- Our own scripts are ES modules: private scope and deferred execution. -->
    <#if properties.scripts?has_content>
        <#list properties.scripts?split(' ') as script>
            <script src="${url.resourcesPath}/${script}" type="module"></script>
        </#list>
    </#if>
    <script type="importmap">
        {
            "imports": {
                "rfc4648": "${url.resourcesCommonPath}/vendor/rfc4648/rfc4648.js"
            }
        }
    </script>
    <script src="${url.resourcesPath}/js/menu-button-links.js" type="module"></script>
    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <script type="module">
        import { startSessionPolling } from "${url.resourcesPath}/js/authChecker.js";

        startSessionPolling(
            "${url.ssoLoginInOtherTabsUrl?no_esc}"
        );
    </script>
    <script type="module">
        document.addEventListener("click", (event) => {
            const link = event.target.closest("a[data-once-link]");

            if (!link) {
                return;
            }

            if (link.getAttribute("aria-disabled") === "true") {
                event.preventDefault();
                return;
            }

            const { disabledClass } = link.dataset;

            if (disabledClass) {
                link.classList.add(...disabledClass.trim().split(/\s+/));
            }

            link.setAttribute("role", "link");
            link.setAttribute("aria-disabled", "true");
        });
    </script>
    <#if authenticationSession??>
        <script type="module">
            import { checkAuthSession } from "${url.resourcesPath}/js/authChecker.js";

            checkAuthSession(
                "${authenticationSession.authSessionIdHash}"
            );
        </script>
    </#if>
</head>

<body class="${properties.kcBodyClass!} ${bodyClass}" data-page-id="login-${pageId}">
<div class="clavis-layout">

    <#-- ------------------------------------------------------------------- -->
    <#-- Brand panel: identity and what the access model is built on.        -->
    <#-- ------------------------------------------------------------------- -->
    <aside class="clavis-brand">
        <div class="clavis-brand__inner">
            <svg class="clavis-brand__logo" viewBox="0 0 64 64" role="img" aria-labelledby="clavis-logo-title" focusable="false">
                <title id="clavis-logo-title">${msg("clavisBrandTitle")}</title>
                <rect x="3" y="6" width="34" height="52" rx="8" fill="currentColor" opacity="0.18"/>
                <rect x="3" y="6" width="34" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="3"/>
                <path d="M12 20h16M12 30h16M12 40h10" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/>
                <path d="M44 36v-4a6 6 0 0 1 12 0v4" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>
                <path fill="currentColor" fill-rule="evenodd" d="M43 36h14a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H43a5 5 0 0 1-5-5V41a5 5 0 0 1 5-5Zm7 6.4a2.6 2.6 0 0 0-1.1 4.95V50a1.1 1.1 0 0 0 2.2 0v-2.65A2.6 2.6 0 0 0 50 42.4Z"/>
            </svg>

            <h2 class="clavis-brand__title">${msg("clavisBrandTitle")}</h2>
            <p class="clavis-brand__tagline">${msg("clavisBrandTagline")}</p>

            <ul class="clavis-brand__points">
                <li class="clavis-brand__point">
                    <span class="clavis-brand__point-icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" focusable="false"><path d="M6.3 11.6 3 8.3l1.2-1.2 2.1 2.1 5.5-5.5L13 4.9z" fill="currentColor"/></svg>
                    </span>
                    <span>${msg("clavisPointRoles")}</span>
                </li>
                <li class="clavis-brand__point">
                    <span class="clavis-brand__point-icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" focusable="false"><path d="M6.3 11.6 3 8.3l1.2-1.2 2.1 2.1 5.5-5.5L13 4.9z" fill="currentColor"/></svg>
                    </span>
                    <span>${msg("clavisPointPermissions")}</span>
                </li>
                <li class="clavis-brand__point">
                    <span class="clavis-brand__point-icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" focusable="false"><path d="M6.3 11.6 3 8.3l1.2-1.2 2.1 2.1 5.5-5.5L13 4.9z" fill="currentColor"/></svg>
                    </span>
                    <span>${msg("clavisPointTokens")}</span>
                </li>
            </ul>
        </div>
    </aside>

    <#-- ------------------------------------------------------------------- -->
    <#-- Form panel.                                                         -->
    <#-- ------------------------------------------------------------------- -->
    <main class="clavis-panel">
        <div class="${properties.kcFormCardClass!}">

            <header class="${properties.kcFormHeaderClass!}">
                <#if realm.internationalizationEnabled && locale.supported?size gt 1>
                    <div class="${properties.kcLocaleMainClass!}" id="kc-locale">
                        <div id="kc-locale-wrapper" class="${properties.kcLocaleWrapperClass!}">
                            <div id="kc-locale-dropdown" class="menu-button-links ${properties.kcLocaleDropDownClass!}">
                                <button tabindex="1" id="kc-current-locale-link" class="clavis-locale__button" type="button"
                                        aria-label="${msg("languages")}" aria-haspopup="true" aria-expanded="false"
                                        aria-controls="language-switch1">${locale.current}</button>
                                <ul role="menu" tabindex="-1" aria-labelledby="kc-current-locale-link" aria-activedescendant=""
                                    id="language-switch1" class="${properties.kcLocaleListClass!}">
                                    <#assign i = 1>
                                    <#list locale.supported as l>
                                        <li role="none">
                                            <a role="menuitem" id="language-${i}" class="${properties.kcLocaleItemClass!}" href="${l.url}">${l.label}</a>
                                        </li>
                                        <#assign i++>
                                    </#list>
                                </ul>
                            </div>
                        </div>
                    </div>
                </#if>

                <#if !(auth?has_content && auth.showUsername() && !auth.showResetCredentials())>
                    <h1 id="kc-page-title" class="clavis-card__title"><#nested "header"></h1>
                    <#if displayRequiredFields>
                        <p class="clavis-card__subtitle"><span class="required">*</span> ${msg("requiredFields")}</p>
                    <#elseif clavisSubtitle?? && clavisSubtitle?has_content>
                        <p class="clavis-card__subtitle">${clavisSubtitle}</p>
                    </#if>
                <#else>
                    <#-- Keycloak already knows who is trying to sign in: show the
                         username and the link that restarts the flow with another
                         account. -->
                    <h1 id="kc-page-title" class="clavis-card__title"><#nested "header"></h1>
                    <#if displayRequiredFields>
                        <p class="clavis-card__subtitle"><span class="required">*</span> ${msg("requiredFields")}</p>
                    </#if>
                    <#nested "show-username">
                    <div id="kc-username" class="clavis-username-echo">
                        <label id="kc-attempted-username">${auth.attemptedUsername}</label>
                        <a id="reset-login" class="clavis-restart-link" href="${url.loginRestartFlowUrl}"
                           aria-label="${msg("restartLoginTooltip")}">${msg("restartLoginTooltip")}</a>
                    </div>
                </#if>
            </header>

            <div class="${properties.kcContentWrapperClass!}" id="kc-content">
                <div id="kc-content-wrapper">

                    <#-- Application-initiated actions must not show the "you still  -->
                    <#-- have to complete this action" warning during login.         -->
                    <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                        <div class="${properties.kcAlertClass!} clavis-alert--${message.type} alert-${message.type}" role="alert">
                            <span class="clavis-alert__icon" aria-hidden="true">
                                <#if message.type = 'success'>
                                    <svg viewBox="0 0 16 16" focusable="false"><path d="M6.3 11.6 3 8.3l1.2-1.2 2.1 2.1 5.5-5.5L13 4.9z" fill="currentColor"/></svg>
                                <#elseif message.type = 'warning'>
                                    <svg viewBox="0 0 16 16" focusable="false"><path d="M8 1.3 15.4 14.2H.6zM7.2 6v4.2h1.6V6zm0 5.4v1.6h1.6v-1.6z" fill="currentColor"/></svg>
                                <#elseif message.type = 'error'>
                                    <svg viewBox="0 0 16 16" focusable="false"><path d="M8 .8a7.2 7.2 0 1 0 0 14.4A7.2 7.2 0 0 0 8 .8m-.8 3.4h1.6v5H7.2zm0 6.4h1.6v1.6H7.2z" fill="currentColor"/></svg>
                                <#else>
                                    <svg viewBox="0 0 16 16" focusable="false"><path d="M8 .8a7.2 7.2 0 1 0 0 14.4A7.2 7.2 0 0 0 8 .8m-.8 2.8h1.6v1.6H7.2zm0 3.2h1.6v5.4H7.2z" fill="currentColor"/></svg>
                                </#if>
                            </span>
                            <span class="${properties.kcAlertTitleClass!}">${kcSanitize(message.summary)?no_esc}</span>
                        </div>
                    </#if>

                    <#nested "form">

                    <#if auth?has_content && auth.showTryAnotherWayLink()>
                        <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post">
                            <div class="${properties.kcFormGroupClass!}">
                                <input type="hidden" name="tryAnotherWay" value="on"/>
                                <a href="#" id="try-another-way" class="clavis-link"
                                   onclick="document.forms['kc-select-try-another-way-form'].requestSubmit();return false;">${msg("doTryAnotherWay")}</a>
                            </div>
                        </form>
                    </#if>

                    <#nested "socialProviders">

                    <#if displayInfo>
                        <div id="kc-info" class="${properties.kcSignUpClass!}">
                            <div id="kc-info-wrapper" class="${properties.kcInfoAreaWrapperClass!}">
                                <#nested "info">
                            </div>
                        </div>
                    </#if>
                </div>
            </div>

            <@loginFooter.content/>
        </div>
    </main>
</div>
</body>
</html>
</#macro>
