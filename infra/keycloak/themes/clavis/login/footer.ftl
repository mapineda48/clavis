<#--
    Footer of the login card.

    In the `base` theme this macro is empty; template.ftl always calls it as
    <@loginFooter.content/>. We use it to make clear that Keycloak, not the
    application, owns the session.
-->
<#macro content>
    <footer class="clavis-footer">
        <p>${msg("clavisFooterSession")}</p>
    </footer>
</#macro>
