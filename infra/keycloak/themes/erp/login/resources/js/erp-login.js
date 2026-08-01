/* =============================================================================
   Tema de login del demo ERP — comportamiento de la chuleta de usuarios.

   Unica responsabilidad: los botones `[data-erp-username]` de la lista de
   usuarios de demostracion rellenan el campo de usuario y pasan el foco al de
   contrasena. Nada mas.

   Deliberadamente NO hace:
     - tocar, rellenar ni recordar contrasenas (ni las de demo),
     - guardar nada en localStorage / sessionStorage / cookies,
     - hacer peticiones de red,
     - depender de ningun modulo externo.

   Se carga desde `theme.properties` (propiedad `scripts`) y el <script> vive en
   el <head>, asi que puede ejecutarse antes de que exista el DOM: todo el
   trabajo se aplaza a DOMContentLoaded. Se escribe como IIFE sin import/export
   para funcionar igual como modulo ES que como script clasico.
   ========================================================================== */

(function () {
  "use strict";

  var SELECTOR_BOTONES = "[data-erp-username]";
  var ID_USUARIO = "username";
  var ID_CONTRASENA = "password";

  /**
   * Marca un boton como inutilizable sin romper nada.
   * Se usa en las pantallas donde Keycloak ya fijo el usuario y, por tanto,
   * no existe el campo que habria que rellenar.
   */
  function desactivarBoton(boton) {
    try {
      if ("disabled" in boton) {
        boton.disabled = true;
      }
      boton.setAttribute("aria-disabled", "true");
      // Para elementos que no son <button> (p. ej. un <a>): fuera del tabulador.
      if (!("disabled" in boton)) {
        boton.setAttribute("tabindex", "-1");
      }
    } catch (error) {
      // Un fallo aqui es cosmetico: jamas debe impedir iniciar sesion.
    }
  }

  /**
   * Rellena el campo de usuario y deja el foco listo para escribir la clave.
   */
  function usarUsuario(campoUsuario, campoContrasena, nombre) {
    campoUsuario.value = nombre;

    // Avisamos a cualquier validacion (nativa o de Keycloak) del cambio.
    // Se construye con `new Event` y, si el navegador no lo permitiera, se
    // recurre al API antiguo: el relleno debe funcionar en cualquier caso.
    var evento;
    try {
      evento = new Event("input", { bubbles: true, cancelable: false });
    } catch (error) {
      evento = document.createEvent("Event");
      evento.initEvent("input", true, false);
    }
    campoUsuario.dispatchEvent(evento);

    // El foco va a la contrasena; si esa pantalla no la pide, al propio usuario.
    var destino = campoContrasena || campoUsuario;
    if (typeof destino.focus === "function") {
      destino.focus();
    }
    // Situa el cursor al final del texto ya escrito, si lo hubiera.
    if (destino === campoUsuario && typeof destino.setSelectionRange === "function") {
      try {
        destino.setSelectionRange(nombre.length, nombre.length);
      } catch (error) {
        // Algunos tipos de input no admiten seleccion: es irrelevante.
      }
    }
  }

  /**
   * Engancha todos los botones de la chuleta. Idempotente y tolerante a que
   * falte cualquier pieza del DOM.
   */
  function inicializar() {
    var botones = document.querySelectorAll(SELECTOR_BOTONES);
    if (!botones || botones.length === 0) {
      return;
    }

    var campoUsuario = document.getElementById(ID_USUARIO);
    var campoContrasena = document.getElementById(ID_CONTRASENA);

    // Sin campo de usuario (pantallas con el usuario ya fijado) los botones no
    // tienen nada que rellenar: se desactivan en lugar de fallar al pulsarlos.
    if (!campoUsuario) {
      for (var i = 0; i < botones.length; i++) {
        desactivarBoton(botones[i]);
      }
      return;
    }

    for (var j = 0; j < botones.length; j++) {
      (function (boton) {
        var nombre = boton.getAttribute("data-erp-username");
        if (!nombre) {
          desactivarBoton(boton);
          return;
        }

        boton.addEventListener("click", function (evento) {
          // Por si la plantilla olvidara el type="button" dentro del <form>.
          evento.preventDefault();
          usarUsuario(campoUsuario, campoContrasena, nombre);
        });
      })(botones[j]);
    }
  }

  // El script puede llegar antes o despues de que el DOM este montado.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inicializar, { once: true });
  } else {
    inicializar();
  }
})();
