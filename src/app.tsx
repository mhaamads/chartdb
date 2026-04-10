import React from 'react';
import { HelmetProvider } from 'react-helmet-async';
import { RouterProvider } from 'react-router-dom';
import { TooltipProvider } from './components/tooltip/tooltip';
import { AuthProvider } from './context/auth-context/auth-provider';
import { HelmetData } from './helmet/helmet-data';
import { router } from './router';

export const App = () => {
    return (
        <HelmetProvider>
            <HelmetData />
            <TooltipProvider>
                <AuthProvider>
                    <RouterProvider router={router} />
                </AuthProvider>
            </TooltipProvider>
        </HelmetProvider>
    );
};
