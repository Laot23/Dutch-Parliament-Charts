// Dutch Parliament Attendance Backend Service
// Run with: node server.js

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Import fetch - handle both CommonJS and ES modules
let fetch;
(async () => {
    try {
        // Try dynamic import for node-fetch v3+
        const { default: nodeFetch } = await import('node-fetch');
        fetch = nodeFetch;
    } catch (error) {
        try {
            // Fallback to require for node-fetch v2
            fetch = require('node-fetch');
        } catch (requireError) {
            console.error('❌ Could not import node-fetch. Please install it:');
            console.error('npm install node-fetch@2');
            process.exit(1);
        }
    }
    console.log('✅ fetch module loaded successfully');
})();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files

// Base URL for the Dutch Parliament API
const BASE_API_URL = 'https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0';

// Utility function to build OData query
function buildQuery(endpoint, filters = [], expands = [], options = {}) {
    let query = `${BASE_API_URL}/${endpoint}`;
    const params = [];
    
    // Add filters
    if (filters.length > 0) {
        params.push(`$filter=${filters.join(' and ')}`);
    }
    
    // Add expands
    if (expands.length > 0) {
        params.push(`$expand=${expands.join(',')}`);
    }
    
    // Add other options (top, skip, orderby, etc.)
    Object.keys(options).forEach(key => {
        if (options[key] !== undefined && options[key] !== null) {
            params.push(`$${key}=${options[key]}`);
        }
    });
    
    // Always add format=json
    params.push('$format=json');
    
    if (params.length > 0) {
        query += '?' + params.join('&');
    }
    
    return query;
}

// Helper function to ensure fetch is available
function checkFetch() {
    if (!fetch) {
        throw new Error('Fetch module not yet loaded. Please wait and try again.');
    }
}

// Route to get attendance data
app.get('/api/attendance', async (req, res) => {
    try {
        checkFetch();
        
        const {
            dateFrom,
            dateTo,
            activityType,
            limit = 1000,
            skip = 0
        } = req.query;

        console.log('Fetching attendance data with params:', req.query);

        // Build filters
        const filters = ['verwijderd eq false']; // Always exclude deleted entities
        
        if (dateFrom) {
            filters.push(`aanvangstijd ge ${dateFrom}T00:00:00Z`);
        }
        
        if (dateTo) {
            filters.push(`aanvangstijd le ${dateTo}T23:59:59Z`);
        }
        
        if (activityType) {
            filters.push(`contains(tolower(onderwerp), tolower('${activityType}'))`);
        }

        // Build expand clause for getting participant data
        const expands = [
            "ActiviteitActor($expand=Persoon,Fractie)"
        ];

        // Build the query
        const query = buildQuery('Activiteit', filters, expands, {
            top: limit,
            skip: skip,
            orderby: 'aanvangstijd desc'
        });

        console.log('API Query:', query);

        // Fetch data from the API
        const response = await fetch(query);
        
        if (!response.ok) {
            throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        // Debug: Log the first few activities' structure
        if (data.value && data.value.length > 0) {
            console.log(`Found ${data.value.length} activities`);
            data.value.slice(0, 3).forEach((activity, index) => {
                console.log(`\nActivity ${index + 1}:`);
                console.log(`- ID: ${activity.Id}`);
                console.log(`- Title: ${activity.Onderwerp}`);
                console.log(`- Date: ${activity.Aanvangstijd || activity.Datum}`);
                console.log(`- Actors: ${activity.ActiviteitActor ? activity.ActiviteitActor.length : 0}`);
                if (activity.ActiviteitActor && activity.ActiviteitActor.length > 0) {
                    console.log(`- First actor: ${JSON.stringify(activity.ActiviteitActor[0], null, 2)}`);
                }
            });
        }

        // Process the data
        const attendanceData = processAttendanceData(data.value || []);
        
        // Get total count if needed
        let totalCount = null;
        if (skip === 0 || skip === '0') {
            try {
                const countQuery = buildQuery('Activiteit', filters, [], { count: 'true' });
                const countResponse = await fetch(countQuery);
                if (countResponse.ok) {
                    const countData = await countResponse.json();
                    totalCount = countData['@odata.count'];
                }
            } catch (countError) {
                console.warn('Could not fetch total count:', countError.message);
            }
        }

        res.json({
            success: true,
            data: attendanceData,
            metadata: {
                totalActivities: data.value?.length || 0,
                totalRegistrations: attendanceData.length,
                totalCount: totalCount,
                skip: parseInt(skip),
                limit: parseInt(limit)
            }
        });

    } catch (error) {
        console.error('Error fetching attendance data:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: 'Failed to fetch attendance data from Dutch Parliament API'
        });
    }
});

// Route to get activity details
app.get('/api/activity/:id', async (req, res) => {
    try {
        checkFetch();
        
        const { id } = req.params;
        
        const query = buildQuery(`Activiteit/${id}`, [], [
            "ActiviteitActor($expand=Persoon,Fractie)"
        ]);

        const response = await fetch(query);
        
        if (!response.ok) {
            throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        res.json({
            success: true,
            data: data
        });

    } catch (error) {
        console.error('Error fetching activity details:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route to get statistics
app.get('/api/stats', async (req, res) => {
    try {
        checkFetch();
        
        const { dateFrom, dateTo, activityType } = req.query;

        // Build filters (same as attendance route)
        const filters = ['verwijderd eq false'];
        
        if (dateFrom) {
            filters.push(`aanvangstijd ge ${dateFrom}T00:00:00Z`);
        }
        
        if (dateTo) {
            filters.push(`aanvangstijd le ${dateTo}T23:59:59Z`);
        }
        
        if (activityType) {
            filters.push(`contains(tolower(onderwerp), tolower('${activityType}'))`);
        }

        // Get activity count
        const activityCountQuery = buildQuery('Activiteit', filters, [], { count: 'true', top: 0 });
        const activityResponse = await fetch(activityCountQuery);
        const activityData = await activityResponse.json();

        // Get some sample data for further statistics
        const sampleQuery = buildQuery('Activiteit', filters, [
            "ActiviteitActor($filter=relatie eq 'Deelnemer';$expand=Persoon,Fractie)"
        ], { top: 100 });
        
        const sampleResponse = await fetch(sampleQuery);
        const sampleData = await sampleResponse.json();
        
        const sampleAttendance = processAttendanceData(sampleData.value || []);
        
        // Calculate statistics from sample
        const uniquePeople = new Set(sampleAttendance.map(d => d.personId)).size;
        const uniqueFractions = new Set(sampleAttendance.map(d => d.fraction)).size;

        res.json({
            success: true,
            stats: {
                totalActivities: activityData['@odata.count'] || 0,
                sampleRegistrations: sampleAttendance.length,
                uniquePeopleInSample: uniquePeople,
                uniqueFractionsInSample: uniqueFractions,
                note: 'Statistics are based on a sample of activities due to API limitations'
            }
        });

    } catch (error) {
        console.error('Error fetching statistics:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Helper function to process attendance data
function processAttendanceData(activities) {
    const attendanceData = [];
    let skippedActivities = 0;
    let activitiesWithoutActors = 0;
    
    console.log(`Processing ${activities.length} activities...`);
    
    activities.forEach((activity, index) => {
        // Skip activities without actors
        if (!activity.ActiviteitActor || activity.ActiviteitActor.length === 0) {
            activitiesWithoutActors++;
            if (index < 5) {
                console.log(`Skipping activity ${activity.Id} (${activity.Onderwerp}): No actors found`);
            }
            return;
        }

        // Validate and parse the start time
        let startTime = null;
        let activityDate = 'Unknown';
        let activityTime = 'Unknown';
        
        try {
            // Use Datum field if Aanvangstijd is not available
            const dateStr = activity.Aanvangstijd || activity.Datum;
            
            if (dateStr) {
                // Parse the date string and handle timezone
                startTime = new Date(dateStr);
                
                // Check if the date is valid
                if (!isNaN(startTime.getTime())) {
                    // Format date in local timezone
                    activityDate = startTime.toLocaleDateString('nl-NL', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit'
                    }).replace(/-/g, '-');
                    
                    // Format time in local timezone
                    activityTime = startTime.toLocaleTimeString('nl-NL', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false
                    });
                }
            }
        } catch (error) {
            console.warn(`Error parsing date for activity ${activity.Id}: ${error.message}`);
        }
        
        const hasValidDate = !!startTime;
        
        activity.ActiviteitActor.forEach(actor => {
            if (actor.Persoon) {
                // Build full name including middle name
                const fullName = [
                    actor.Persoon.Voornamen,
                    actor.Persoon.Tussenvoegsel,
                    actor.Persoon.Achternaam
                ].filter(Boolean).join(' ');

                // Get fraction name in Dutch
                const fractionName = actor.Fractie ? actor.Fractie.NaamNL : 'Unknown';
                
                attendanceData.push({
                    activityId: activity.Id,
                    activityTitle: activity.Onderwerp || 'Unknown Activity',
                    activityDate: activityDate,
                    activityTime: activityTime,
                    activityDateTime: activity.Aanvangstijd || activity.Datum,
                    personId: actor.Persoon.Id,
                    personName: fullName,
                    personInitials: actor.Persoon.Initialen || '',
                    personFirstName: actor.Persoon.Voornamen || '',
                    personLastName: [
                        actor.Persoon.Tussenvoegsel,
                        actor.Persoon.Achternaam
                    ].filter(Boolean).join(' '),
                    fraction: fractionName,
                    fractionId: actor.Fractie ? actor.Fractie.Id : null,
                    role: actor.Functie || 'Participant',
                    actorId: actor.Id,
                    hasValidDate: hasValidDate
                });
            }
        });
    });
    
    console.log(`✅ Processed ${attendanceData.length} attendance records`);
    if (activitiesWithoutActors > 0) {
        console.log(`ℹ️  Skipped ${activitiesWithoutActors} activities without actors`);
    }
    
    return attendanceData;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Dutch Parliament Attendance API is running',
        timestamp: new Date().toISOString(),
        fetchAvailable: !!fetch
    });
});

// Serve the frontend HTML
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dutch Parliament Attendance API</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 { color: #2c3e50; }
        .endpoint {
            background: #f8f9fa;
            padding: 15px;
            margin: 10px 0;
            border-radius: 5px;
            border-left: 4px solid #007bff;
        }
        .method {
            background: #007bff;
            color: white;
            padding: 3px 8px;
            border-radius: 3px;
            font-size: 12px;
            font-weight: bold;
        }
        code {
            background: #e9ecef;
            padding: 2px 4px;
            border-radius: 3px;
            font-family: 'Monaco', 'Courier New', monospace;
        }
        .example {
            background: #e8f5e8;
            padding: 10px;
            border-radius: 5px;
            margin-top: 10px;
        }
        .warning {
            background: #fff3cd;
            border: 1px solid #ffeaa7;
            color: #856404;
            padding: 15px;
            border-radius: 5px;
            margin: 15px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🏛️ Dutch Parliament Attendance API</h1>
        <p>This backend service provides access to Dutch Parliament attendance data without CORS restrictions.</p>
        
        ${!fetch ? '<div class="warning"><strong>⚠️ Warning:</strong> Fetch module is still loading. API endpoints may not work yet.</div>' : '<div style="color: green;">✅ Fetch module loaded successfully</div>'}
        
        <h2>Available Endpoints</h2>
        
        <div class="endpoint">
            <span class="method">GET</span> <code>/api/attendance</code>
            <p>Get attendance data with optional filters</p>
            <strong>Query Parameters:</strong>
            <ul>
                <li><code>dateFrom</code> - Start date (YYYY-MM-DD)</li>
                <li><code>dateTo</code> - End date (YYYY-MM-DD)</li>
                <li><code>activityType</code> - Filter by activity type</li>
                <li><code>limit</code> - Max results (default: 1000)</li>
                <li><code>skip</code> - Skip results for pagination (default: 0)</li>
            </ul>
            <div class="example">
                <strong>Example:</strong><br>
                <code>/api/attendance?dateFrom=2024-01-01&dateTo=2024-12-31&limit=100</code>
            </div>
        </div>
        
        <div class="endpoint">
            <span class="method">GET</span> <code>/api/activity/:id</code>
            <p>Get detailed information about a specific activity</p>
            <div class="example">
                <strong>Example:</strong><br>
                <code>/api/activity/a7fbfbe6-48ee-4182-b9ed-f49d34be4eab</code>
            </div>
        </div>
        
        <div class="endpoint">
            <span class="method">GET</span> <code>/api/stats</code>
            <p>Get statistics about activities and attendance</p>
            <strong>Query Parameters:</strong> Same as attendance endpoint
            <div class="example">
                <strong>Example:</strong><br>
                <code>/api/stats?dateFrom=2024-01-01&dateTo=2024-12-31</code>
            </div>
        </div>
        
        <div class="endpoint">
            <span class="method">GET</span> <code>/api/health</code>
            <p>Health check endpoint</p>
        </div>
        
        <h2>Setup Instructions</h2>
        <ol>
            <li>Save this code as <code>server.js</code></li>
            <li>Initialize npm: <code>npm init -y</code></li>
            <li>Install dependencies: <code>npm install express cors node-fetch@2</code></li>
            <li>Run the server: <code>node server.js</code></li>
            <li>Access the API at <code>http://localhost:3000</code></li>
        </ol>
        
        <h2>Troubleshooting</h2>
        <p>If you get fetch errors, try:</p>
        <ul>
            <li><code>npm uninstall node-fetch</code></li>
            <li><code>npm install node-fetch@2</code></li>
            <li>Restart the server</li>
        </ul>
    </div>
</body>
</html>
    `);
});

// Start the server
app.listen(PORT, () => {
    console.log(`🏛️  Dutch Parliament Attendance API Server running on port ${PORT}`);
    console.log(`📡 API Base URL: http://localhost:${PORT}/api`);
    console.log(`🌐 Documentation: http://localhost:${PORT}`);
    console.log('');
    console.log('Available endpoints:');
    console.log(`   GET /api/attendance - Get attendance data`);
    console.log(`   GET /api/activity/:id - Get activity details`);
    console.log(`   GET /api/stats - Get statistics`);
    console.log(`   GET /api/health - Health check`);
    
    // Give some time for fetch to load
    setTimeout(() => {
        if (!fetch) {
            console.log('⚠️  Warning: Fetch module may not be loaded yet.');
            console.log('   If you get errors, try installing: npm install node-fetch@2');
        }
    }, 1000);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    process.exit(0);
});

module.exports = app;