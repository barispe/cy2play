describe('Login', () => {
  beforeEach(() => {
    cy.visit('/login');
  });

  it('should log in successfully', () => {
    cy.get('[data-cy=email]').type('user@test.com');
    cy.get('[data-cy=password]').type('password123');
    cy.get('[data-cy=submit]').click();
    cy.url().should('include', '/dashboard');
  });

  it('should show error for invalid credentials', () => {
    cy.get('[data-cy=email]').type('bad@test.com');
    cy.get('[data-cy=password]').type('wrong');
    cy.get('[data-cy=submit]').click();
    cy.get('.error-message').should('be.visible');
    cy.get('.error-message').should('have.text', 'Invalid credentials');
  });
});
