<#--
    Layout de todas las pantallas de login del demo ERP.

    Parte del template.ftl del tema `base` de Keycloak 26.4 y conserva su contrato
    al pie de la letra:
      - la firma de la macro (bodyClass, displayInfo, displayMessage, displayRequiredFields),
      - las cinco secciones anidadas y su orden:
        "header", "show-username", "form", "socialProviders", "info",
      - todos los <script> del <head> (importmap de rfc4648, menu-button-links,
        authChecker/startSessionPolling, el manejador de data-once-link y el bloque
        condicional de authenticationSession) y el <link rel="icon">.

    Lo unico que cambia es el HTML: pantalla partida con panel de marca a la
    izquierda (identidad + chuleta de usuarios demo) y tarjeta de formulario a la
    derecha.

    Las plantillas hijas pueden declarar un subtitulo para la tarjeta con:
        <#global erpSubtitle = msg("...")>
    antes de invocar la macro. Si no lo hacen, no se pinta nada.
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
    <link rel="icon" href="${url.resourcesPath}/img/favicon.ico" />
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
    <#-- Nuestros scripts son modulos ES: ambito propio y ejecucion diferida. -->
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
<div class="erp-layout">

    <#-- ------------------------------------------------------------------- -->
    <#-- Panel de marca: identidad del demo y chuleta de usuarios de prueba.  -->
    <#-- ------------------------------------------------------------------- -->
    <aside class="erp-brand">
        <div class="erp-brand__inner">
            <svg class="erp-brand__logo" viewBox="0 0 64 64" role="img" aria-labelledby="erp-logo-title" focusable="false">
                <title id="erp-logo-title">${msg("erpBrandTitle")}</title>
                <rect x="3" y="6" width="34" height="52" rx="8" fill="currentColor" opacity="0.18"/>
                <rect x="3" y="6" width="34" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="3"/>
                <path d="M12 20h16M12 30h16M12 40h10" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/>
                <path d="M44 36v-4a6 6 0 0 1 12 0v4" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>
                <path fill="currentColor" fill-rule="evenodd" d="M43 36h14a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H43a5 5 0 0 1-5-5V41a5 5 0 0 1 5-5Zm7 6.4a2.6 2.6 0 0 0-1.1 4.95V50a1.1 1.1 0 0 0 2.2 0v-2.65A2.6 2.6 0 0 0 50 42.4Z"/>
            </svg>

            <h2 class="erp-brand__title">${msg("erpBrandTitle")}</h2>
            <p class="erp-brand__tagline">${msg("erpBrandTagline")}</p>

            <ul class="erp-brand__points">
                <li class="erp-brand__point">
                    <span class="erp-brand__point-icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" focusable="false"><path d="M6.3 11.6 3 8.3l1.2-1.2 2.1 2.1 5.5-5.5L13 4.9z" fill="currentColor"/></svg>
                    </span>
                    <span>${msg("erpPointRoles")}</span>
                </li>
                <li class="erp-brand__point">
                    <span class="erp-brand__point-icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" focusable="false"><path d="M6.3 11.6 3 8.3l1.2-1.2 2.1 2.1 5.5-5.5L13 4.9z" fill="currentColor"/></svg>
                    </span>
                    <span>${msg("erpPointPermissions")}</span>
                </li>
                <li class="erp-brand__point">
                    <span class="erp-brand__point-icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" focusable="false"><path d="M6.3 11.6 3 8.3l1.2-1.2 2.1 2.1 5.5-5.5L13 4.9z" fill="currentColor"/></svg>
                    </span>
                    <span>${msg("erpPointTokens")}</span>
                </li>
            </ul>

            <section class="erp-users" aria-labelledby="erp-users-title">
                <h3 class="erp-users__title" id="erp-users-title">${msg("erpDemoUsersTitle")}</h3>

                <div class="erp-user">
                    <div class="erp-user__head">
                        <span class="erp-user__name">admin</span>
                        <span class="erp-user__role">erp-admin</span>
                    </div>
                    <div class="erp-user__perms">
                        <span class="erp-perm">todos:read</span>
                        <span class="erp-perm">todos:write</span>
                        <span class="erp-perm">todos:read:all</span>
                        <span class="erp-perm">todos:delete</span>
                        <span class="erp-perm">users:read</span>
                        <span class="erp-perm">admin:manage</span>
                    </div>
                    <button type="button" class="erp-user__use" tabindex="9"
                            data-erp-username="admin"
                            aria-label="${msg('erpUseAria','admin')}">${msg("erpUse")}</button>
                </div>

                <div class="erp-user">
                    <div class="erp-user__head">
                        <span class="erp-user__name">manager</span>
                        <span class="erp-user__role">erp-manager</span>
                    </div>
                    <div class="erp-user__perms">
                        <span class="erp-perm">todos:read</span>
                        <span class="erp-perm">todos:write</span>
                        <span class="erp-perm">todos:read:all</span>
                        <span class="erp-perm">todos:delete</span>
                        <span class="erp-perm">users:read</span>
                    </div>
                    <button type="button" class="erp-user__use" tabindex="10"
                            data-erp-username="manager"
                            aria-label="${msg('erpUseAria','manager')}">${msg("erpUse")}</button>
                </div>

                <div class="erp-user">
                    <div class="erp-user__head">
                        <span class="erp-user__name">worker</span>
                        <span class="erp-user__role">erp-user</span>
                    </div>
                    <div class="erp-user__perms">
                        <span class="erp-perm">todos:read</span>
                        <span class="erp-perm">todos:write</span>
                    </div>
                    <button type="button" class="erp-user__use" tabindex="11"
                            data-erp-username="worker"
                            aria-label="${msg('erpUseAria','worker')}">${msg("erpUse")}</button>
                </div>

                <#-- Nunca escribimos contrasenas en el tema: solo se dice donde estan. -->
                <p class="erp-users__note">${msg("erpDemoUsersNote")}</p>
            </section>
        </div>
    </aside>

    <#-- ------------------------------------------------------------------- -->
    <#-- Panel del formulario.                                               -->
    <#-- ------------------------------------------------------------------- -->
    <main class="erp-panel">
        <div class="${properties.kcFormCardClass!}">

            <header class="${properties.kcFormHeaderClass!}">
                <#if realm.internationalizationEnabled && locale.supported?size gt 1>
                    <div class="${properties.kcLocaleMainClass!}" id="kc-locale">
                        <div id="kc-locale-wrapper" class="${properties.kcLocaleWrapperClass!}">
                            <div id="kc-locale-dropdown" class="menu-button-links ${properties.kcLocaleDropDownClass!}">
                                <button tabindex="1" id="kc-current-locale-link" class="erp-locale__button" type="button"
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
                    <h1 id="kc-page-title" class="erp-card__title"><#nested "header"></h1>
                    <#if displayRequiredFields>
                        <p class="erp-card__subtitle"><span class="required">*</span> ${msg("requiredFields")}</p>
                    <#elseif erpSubtitle?? && erpSubtitle?has_content>
                        <p class="erp-card__subtitle">${erpSubtitle}</p>
                    </#if>
                <#else>
                    <#-- Keycloak ya sabe quien intenta entrar: mostramos el usuario y
                         el enlace para reiniciar el flujo con otra cuenta. -->
                    <h1 id="kc-page-title" class="erp-card__title"><#nested "header"></h1>
                    <#if displayRequiredFields>
                        <p class="erp-card__subtitle"><span class="required">*</span> ${msg("requiredFields")}</p>
                    </#if>
                    <#nested "show-username">
                    <div id="kc-username" class="erp-username-echo">
                        <label id="kc-attempted-username">${auth.attemptedUsername}</label>
                        <a id="reset-login" class="erp-restart-link" href="${url.loginRestartFlowUrl}"
                           aria-label="${msg("restartLoginTooltip")}">${msg("restartLoginTooltip")}</a>
                    </div>
                </#if>
            </header>

            <div class="${properties.kcContentWrapperClass!}" id="kc-content">
                <div id="kc-content-wrapper">

                    <#-- Las acciones iniciadas por la aplicacion no deben ver el aviso -->
                    <#-- de "tienes que completar la accion" durante el login.          -->
                    <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                        <div class="${properties.kcAlertClass!} erp-alert--${message.type} alert-${message.type}" role="alert">
                            <span class="erp-alert__icon" aria-hidden="true">
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
                                <a href="#" id="try-another-way" class="erp-link"
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
