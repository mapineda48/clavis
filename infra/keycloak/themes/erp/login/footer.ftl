<#--
    Pie de la tarjeta de login.

    En el tema `base` esta macro esta vacia; template.ftl la invoca siempre como
    <@loginFooter.content/>. Aqui la usamos para dejar claro que esto es un entorno
    de demostracion y que la sesion la gobierna Keycloak.

    Nunca se muestran credenciales: solo se indica donde estan documentadas.
-->
<#macro content>
    <footer class="erp-footer">
        <p>${msg("erpFooterDemo")}</p>
        <p>${msg("erpFooterSession")}</p>
    </footer>
</#macro>
