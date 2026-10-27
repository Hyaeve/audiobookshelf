import ItemTaskRunningCard from '@/components/cards/ItemTaskRunningCard.vue'
import Btn from '@/components/ui/Btn.vue'
import LoadingSpinner from '@/components/widgets/LoadingSpinner.vue'
import { mutations, state } from '@/store/tasks'

describe('ItemTaskRunningCard book activities', () => {
  const makeTask = (action = 'strm-metadata-completion') => ({
    id: 'task',
    action,
    title: '媒体预读：第一本书',
    startedAt: 1,
    isFinished: false,
    data: { libraryItemId: 'first', libraryItemTitle: '第一本书', canCancelPreload: true, totalTracks: 100, scannedTracks: 20 }
  })

  function mountTask(task = makeTask(), isAdmin = true, post = cy.stub().resolves({ cancelled: true })) {
    cy.intercept('GET', '/api/items/*/cover*', { fixture: 'images/cover1.jpg' })
    return cy.mount(ItemTaskRunningCard, {
      propsData: { task },
      mocks: {
        $store: { getters: {
          'user/getIsAdminOrUp': isAdmin,
          'globals/getPlaceholderCoverSrc': '/book_placeholder.jpg',
          'globals/getLibraryItemCoverSrcById': (id) => `/api/items/${id}/cover`
        } },
        $axios: { $post: post },
        $toast: { error: cy.spy().as('error') }
      },
      stubs: {
        'widgets-loading-spinner': LoadingSpinner,
        'ui-btn': Btn
      }
    })
  }

  it('shows the book cover and cancels only the book currently displayed', () => {
    const post = cy.stub().resolves({ cancelled: true }).as('cancel')
    mountTask(makeTask(), true, post)
    cy.get('img').should('have.attr', 'src', '/api/items/first/cover')
    cy.contains('20/100').should('be.visible')
    cy.contains('button', 'Cancel').click()
    cy.get('@cancel').should('have.been.calledOnceWithExactly', '/api/tasks/task/cancel-preload', { libraryItemId: 'first' })
    cy.contains('button', 'Cancel').should('be.disabled')
  })

  it('updates the cover and restores cancellation when a batch advances to another book', () => {
    mountTask().then(({ wrapper }) => {
      return cy.contains('button', 'Cancel').click().then(() => {
        wrapper.setProps({ task: { ...makeTask(), data: { ...makeTask().data, libraryItemId: 'second', libraryItemTitle: '第二本书' } } })
      })
    })
    cy.get('img').should('have.attr', 'src', '/api/items/second/cover')
    cy.contains('button', 'Cancel').should('not.be.disabled')
  })

  for (const action of ['encode-m4b', 'embed-metadata', 'scan-item', 'ai-book-match', 'book-metadata-completion', 'chinese-search']) {
    it(`shows a cover for ${action} book activities without a media preload cancel button`, () => {
      mountTask(makeTask(action))
      cy.get('img').should('have.attr', 'src', '/api/items/first/cover')
      cy.get('button').should('not.exist')
    })
  }

  it('does not offer cancellation to a non-administrator', () => {
    mountTask(makeTask(), false)
    cy.get('button').should('not.exist')
  })

  it('reports cancellation errors and enables retry', () => {
    mountTask(makeTask(), true, cy.stub().rejects(new Error('offline')))
    cy.contains('button', 'Cancel').click()
    cy.get('@error').should('have.been.calledOnce')
    cy.contains('button', 'Cancel').should('not.be.disabled')
  })

  it('keeps the original icon for activities not associated with a book', () => {
    mountTask({ ...makeTask('library-scan'), data: { libraryId: 'library' } })
    cy.get('img').should('not.exist')
  })

  it('does not remove a running batch activity when another preload of the same book is announced', () => {
    const store = state()
    mutations.addUpdateTask(store, makeTask())
    mutations.addUpdateTask(store, { ...makeTask(), id: 'playback-task' })
    expect(store.tasks).to.have.length(2)
  })

  it('retains the existing deduplication of completed activities', () => {
    const store = state()
    mutations.addUpdateTask(store, { ...makeTask(), isFinished: true })
    mutations.addUpdateTask(store, { ...makeTask(), id: 'next-task' })
    expect(store.tasks).to.have.length(1)
  })

  it('renders a compact activity card on a narrow screen', () => {
    cy.viewport(375, 667)
    mountTask()
    cy.get('img').should('have.prop', 'naturalWidth').and('be.greaterThan', 0)
    cy.get('img').parent().parent()
      .invoke('css', { width: '320px', color: 'white', backgroundColor: 'rgb(31, 41, 55)' })
      .screenshot('media-preload-running-mobile')
    cy.contains('button', 'Cancel').click()
    cy.get('[role="status"]').should('be.visible')
    cy.get('img').parent().parent().screenshot('media-preload-canceling-mobile')
  })
})
