import http from '@/axios/index.js';

export function companyLoginConfiguration() {
    return http.get('/oauth/company/config')
}

export function exchangeCompanyLogin() {
    return http.post('/oauth/company/exchange')
}

export function login(email, password) {
    return http.post('/login', {email: email, password: password})
}

export function logout() {
    return http.delete('/logout')
}

export function register(form) {
    return http.post('/register', form)
}
