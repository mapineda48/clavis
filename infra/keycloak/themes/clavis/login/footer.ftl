<#--
    Footer of the login card.

    In the `base` theme this macro is empty; template.ftl always calls it as
    <@loginFooter.content/>. We use it to make clear that this is a demo
    environment and that Keycloak, not the app, owns the session.

    Credentials are never shown: we only point at where they are documented.
-->
<#macro content>
    <footer class="clavis-footer">
        <p>${msg("clavisFooterDemo")}</p>
        <p>${msg("clavisFooterSession")}</p>
    </footer>
</#macro>
