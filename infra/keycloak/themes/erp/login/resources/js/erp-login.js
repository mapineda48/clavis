/* =============================================================================
   ERP demo login theme — behaviour of the demo user cheat sheet.

   Single responsibility: the `[data-erp-username]` buttons in the demo user list
   fill in the username field and move the focus to the password field. Nothing
   else.

   Deliberately does NOT:
     - touch, fill in or remember passwords (not even the demo ones),
     - store anything in localStorage / sessionStorage / cookies,
     - make network requests,
     - depend on any external module.

   It is loaded from `theme.properties` (the `scripts` property) and the <script>
   lives in the <head>, so it can run before the DOM exists: all the work is
   deferred to DOMContentLoaded. Written as an IIFE with no import/export so it
   behaves the same as an ES module and as a classic script.
   ========================================================================== */

(function () {
  "use strict";

  var BUTTON_SELECTOR = "[data-erp-username]";
  var USERNAME_FIELD_ID = "username";
  var PASSWORD_FIELD_ID = "password";

  /**
   * Marks a button as unusable without breaking anything.
   * Used on the screens where Keycloak already fixed the username and, as a
   * result, the field we would fill in does not exist.
   */
  function disableButton(button) {
    try {
      if ("disabled" in button) {
        button.disabled = true;
      }
      button.setAttribute("aria-disabled", "true");
      // For elements that are not a <button> (an <a>, say): out of the tab order.
      if (!("disabled" in button)) {
        button.setAttribute("tabindex", "-1");
      }
    } catch (error) {
      // A failure here is cosmetic: it must never block signing in.
    }
  }

  /**
   * Fills in the username field and leaves the focus ready to type the password.
   */
  function fillUsername(usernameField, passwordField, username) {
    usernameField.value = username;

    // Let any validation (native or Keycloak's) know about the change. The event
    // is built with `new Event` and, should the browser not allow that, we fall
    // back to the old API: filling in the field has to work either way.
    var event;
    try {
      event = new Event("input", { bubbles: true, cancelable: false });
    } catch (error) {
      event = document.createEvent("Event");
      event.initEvent("input", true, false);
    }
    usernameField.dispatchEvent(event);

    // Focus goes to the password; if that screen does not ask for one, it stays
    // on the username field itself.
    var target = passwordField || usernameField;
    if (typeof target.focus === "function") {
      target.focus();
    }
    // Put the caret after the text already there, if any.
    if (target === usernameField && typeof target.setSelectionRange === "function") {
      try {
        target.setSelectionRange(username.length, username.length);
      } catch (error) {
        // Some input types do not support selection: it does not matter here.
      }
    }
  }

  /**
   * Wires up every cheat sheet button. Idempotent and tolerant of any missing
   * piece of the DOM.
   */
  function init() {
    var buttons = document.querySelectorAll(BUTTON_SELECTOR);
    if (!buttons || buttons.length === 0) {
      return;
    }

    var usernameField = document.getElementById(USERNAME_FIELD_ID);
    var passwordField = document.getElementById(PASSWORD_FIELD_ID);

    // With no username field (screens where the username is already fixed) the
    // buttons have nothing to fill in: disable them instead of failing on click.
    if (!usernameField) {
      for (var i = 0; i < buttons.length; i++) {
        disableButton(buttons[i]);
      }
      return;
    }

    for (var j = 0; j < buttons.length; j++) {
      (function (button) {
        var username = button.getAttribute("data-erp-username");
        if (!username) {
          disableButton(button);
          return;
        }

        button.addEventListener("click", function (event) {
          // In case the template ever forgets type="button" inside the <form>.
          event.preventDefault();
          fillUsername(usernameField, passwordField, username);
        });
      })(buttons[j]);
    }
  }

  // The script may arrive before or after the DOM is in place.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
