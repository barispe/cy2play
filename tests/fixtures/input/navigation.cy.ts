describe('Navigation', () => {
  it('should navigate to about page', () => {
    cy.visit('/');
    cy.get('a[href="/about"]').click();
    cy.url().should('include', '/about');
    cy.get('h1').should('have.text', 'About Us');
  });

  it('should wait for API response', () => {
    cy.intercept('GET', '/api/users').as('getUsers');
    cy.visit('/users');
    cy.wait('@getUsers');
    cy.get('.user-list li').should('have.length.greaterThan', 0);
  });

  it('should handle checkbox and select', () => {
    cy.visit('/settings');
    cy.get('#notifications').check();
    cy.get('#notifications').should('be.checked');
    cy.get('#theme').select('dark');
    cy.get('#theme').should('have.value', 'dark');
  });
});
