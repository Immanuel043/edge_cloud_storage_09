#!/bin/bash

# =============================================================================
# Edge Cloud Storage - Test Runner Script
# Quick script to run all tests or specific test categories
# =============================================================================

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored output
print_header() {
    echo -e "${BLUE}============================================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}============================================================${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

# =============================================================================
# Functions
# =============================================================================

run_backend_tests() {
    print_header "Running Backend Python Tests"

    # Check if pytest is installed
    if ! command -v pytest &> /dev/null; then
        print_error "pytest is not installed. Installing..."
        pip install -r tests/requirements.txt
    fi

    # Run tests
    if [ "$1" == "coverage" ]; then
        pytest tests/ -v --cov=services/storage-service/app --cov-report=html --cov-report=term-missing
        print_success "Coverage report generated at: htmlcov/index.html"
    else
        pytest tests/ -v
    fi
}

run_frontend_tests() {
    print_header "Running Frontend React Tests"

    cd frontend-clean

    # Check if node_modules exists
    if [ ! -d "node_modules" ]; then
        print_warning "node_modules not found. Running npm install..."
        npm install
    fi

    # Run tests
    if [ "$1" == "coverage" ]; then
        npm run test:coverage
        print_success "Coverage report generated at: frontend-clean/coverage/index.html"
    else
        npm test
    fi

    cd ..
}

run_web_service_tests() {
    print_header "Running Web Service Node.js Tests"

    cd services/web-service

    # Check if node_modules exists
    if [ ! -d "node_modules" ]; then
        print_warning "node_modules not found. Running npm install..."
        npm install
    fi

    # Run tests
    if [ "$1" == "coverage" ]; then
        npm test -- --coverage
        print_success "Coverage report generated"
    else
        npm test
    fi

    cd ../..
}

run_ml_tests() {
    print_header "Running ML Feature Tests"
    pytest tests/unit/ml_features/ -v -m ml --cov=services/storage-service/app
}

run_api_tests() {
    print_header "Running API Tests"
    pytest tests/unit/api/ -v -m api
}

run_integration_tests() {
    print_header "Running Integration Tests"
    pytest tests/integration/ -v
}

run_all_tests() {
    print_header "Running All Tests"

    run_backend_tests "$1"
    run_frontend_tests "$1"
    run_web_service_tests "$1"

    print_success "All tests completed!"
}

run_quick_tests() {
    print_header "Running Quick Tests (Unit Tests Only)"
    pytest tests/unit/ -v --maxfail=3
}

run_linting() {
    print_header "Running Code Quality Checks"

    echo "Running Black (formatter check)..."
    black --check services/storage-service/app/ || print_warning "Black formatting issues found"

    echo "Running isort (import sorting check)..."
    isort --check-only services/storage-service/app/ || print_warning "isort issues found"

    echo "Running flake8 (linting)..."
    flake8 services/storage-service/app/ --max-line-length=100 --exclude=migrations || print_warning "flake8 issues found"

    echo "Running bandit (security linting)..."
    bandit -r services/storage-service/app/ -x tests/ || print_warning "Security issues found"

    print_success "Linting complete"
}

install_dependencies() {
    print_header "Installing Test Dependencies"

    # Python dependencies
    print_warning "Installing Python test dependencies..."
    pip install -r tests/requirements.txt

    # Frontend dependencies
    print_warning "Installing Frontend dependencies..."
    cd frontend-clean && npm install && cd ..

    # Web service dependencies
    print_warning "Installing Web service dependencies..."
    cd services/web-service && npm install && cd ../..

    print_success "All dependencies installed"
}

show_help() {
    cat << EOF
${BLUE}Edge Cloud Storage - Test Runner${NC}

${GREEN}Usage:${NC}
  ./run-tests.sh [command] [options]

${GREEN}Commands:${NC}
  all               Run all tests (backend + frontend + web-service)
  backend           Run backend Python tests
  frontend          Run frontend React tests
  web-service       Run web service Node.js tests
  ml                Run ML feature tests only
  api               Run API tests only
  integration       Run integration tests
  quick             Run quick unit tests only
  lint              Run code quality checks
  install           Install all test dependencies
  help              Show this help message

${GREEN}Options:${NC}
  coverage          Generate coverage report

${GREEN}Examples:${NC}
  ./run-tests.sh all                    # Run all tests
  ./run-tests.sh all coverage           # Run all tests with coverage
  ./run-tests.sh backend                # Run backend tests only
  ./run-tests.sh backend coverage       # Run backend tests with coverage
  ./run-tests.sh ml                     # Run ML feature tests
  ./run-tests.sh quick                  # Run quick unit tests
  ./run-tests.sh lint                   # Run linting
  ./run-tests.sh install                # Install dependencies

${GREEN}Coverage Reports:${NC}
  Backend:      htmlcov/index.html
  Frontend:     frontend-clean/coverage/index.html

${GREEN}CI/CD:${NC}
  Tests run automatically on every push and PR via GitHub Actions
  Nightly tests run at 2 AM UTC
  View results: GitHub Actions tab

${GREEN}Documentation:${NC}
  tests/README.md         - Comprehensive testing documentation
  TESTING_GUIDE.md        - Quick start guide

EOF
}

# =============================================================================
# Main Script
# =============================================================================

main() {
    case "$1" in
        all)
            run_all_tests "$2"
            ;;
        backend)
            run_backend_tests "$2"
            ;;
        frontend)
            run_frontend_tests "$2"
            ;;
        web-service)
            run_web_service_tests "$2"
            ;;
        ml)
            run_ml_tests
            ;;
        api)
            run_api_tests
            ;;
        integration)
            run_integration_tests
            ;;
        quick)
            run_quick_tests
            ;;
        lint)
            run_linting
            ;;
        install)
            install_dependencies
            ;;
        help|--help|-h|"")
            show_help
            ;;
        *)
            print_error "Unknown command: $1"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@"
