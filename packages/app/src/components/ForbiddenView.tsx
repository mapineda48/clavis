import { Link } from '@tanstack/react-router'
import { useI18n } from '../i18n/I18nProvider'

/**
 * Where a permission guard sends the user. Reaching this view by URL is the
 * expected path: the navigation never offers a link the user cannot follow.
 */
export function ForbiddenView() {
  const { t } = useI18n()

  return (
    <section className="panel panel--center">
      <h2 className="panel__title">{t('forbidden.title')}</h2>
      <p className="muted">{t('forbidden.lead')}</p>
      <Link to="/" className="btn">
        {t('forbidden.backHome')}
      </Link>
    </section>
  )
}
