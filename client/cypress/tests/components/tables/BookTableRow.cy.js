import BookCover from '@/components/covers/BookCover.vue'
import BookTableRow from '@/components/tables/collection/BookTableRow.vue'
import IconBtn from '@/components/ui/IconBtn.vue'
import ReadIconBtn from '@/components/ui/ReadIconBtn.vue'
import Tooltip from '@/components/ui/Tooltip.vue'
import LoadingSpinner from '@/components/widgets/LoadingSpinner.vue'

describe('Collection book row permissions', () => {
  function mountRow({ canUpdate, canDelete, remove }) {
    cy.intercept('GET', '/api/items/book/cover', { fixture: 'images/cover1.jpg' })
    cy.mount(BookTableRow, {
      propsData: {
        collectionId: 'collection',
        book: { id: 'book', media: { coverPath: '/cover.jpg', metadata: { title: 'Test audiobook' } } },
        bookCoverAspectRatio: 1.6
      },
      mocks: {
        $store: {
          state: { globals: { isMobile: true } },
          getters: {
            'user/getUserCanUpdate': canUpdate,
            'user/getUserCanDelete': canDelete,
            'user/getUserMediaProgress': () => null,
            'globals/getLibraryItemCoverSrc': () => '/api/items/book/cover'
          }
        },
        $axios: { $delete: remove },
        $toast: { success: cy.spy() }
      },
      stubs: {
        'covers-book-cover': BookCover,
        'nuxt-link': { template: '<a><slot /></a>' },
        'ui-icon-btn': IconBtn,
        'ui-read-icon-btn': ReadIconBtn,
        'ui-tooltip': Tooltip,
        'widgets-loading-spinner': LoadingSpinner
      }
    }).then(({ wrapper }) => cy.wrap(wrapper.element).as('row'))
    cy.get('@row').invoke('css', {
      backgroundColor: 'rgb(31, 41, 55)',
      color: 'white'
    })
    cy.get('@row').find('img').its('0.naturalWidth').should('be.greaterThan', 0)
    cy.get('@row').trigger('mouseover')
  }

  it('offers removal to an editor who cannot delete the collection', () => {
    cy.viewport(390, 700)
    const remove = cy.stub().resolves({}).as('remove')
    mountRow({ canUpdate: true, canDelete: false, remove })
    cy.get('@row').contains('button', /^close$/).should('be.visible')
    if (Cypress.env('visualReview')) cy.get('@row').screenshot('collection-editor')
    cy.get('@row').contains('button', /^close$/).click()
    cy.get('@remove').should('have.been.calledOnceWithExactly', '/api/collections/collection/book/book')
  })

  it('hides removal for a user who can delete but cannot edit', () => {
    cy.viewport(390, 700)
    mountRow({ canUpdate: false, canDelete: true })
    cy.get('@row').contains('button', /^close$/).should('not.exist')
    if (Cypress.env('visualReview')) cy.get('@row').screenshot('collection-delete-only')
  })
})
