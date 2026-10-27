import type { Metadata } from "next";
import DocPage from "@/components/DocPage";

export const metadata: Metadata = { title: "About FirePulse and its data" };

export default function About() {
  return (
    <DocPage title="About FirePulse and its data">
      <p>
        FirePulse shows wildfires, evacuation orders and fire weather near the places you care about, and can alert your
        devices when something changes. It combines official fire records with satellite heat detections, so a new fire
        can appear before it is officially mapped, and it labels the difference clearly.
      </p>
      <p>
        <strong>FirePulse is not an official warning service.</strong> Data can be hours old, incomplete or wrong, and
        the spread forecast is an experimental model that knows nothing about firefighting. Evacuation orders come from
        local authorities. Follow them, and call 911 in an emergency.
      </p>

      <h2>How a fire gets on the map</h2>
      <ul>
        <li>
          <strong>Official fires</strong> come from the National Interagency Fire Center: perimeters, containment and
          planned (prescribed) burns.
        </li>
        <li>
          <strong>Possible fires</strong> are clusters of satellite heat detections. Heat seen in one satellite pass is
          often a farm or industrial burn, so it stays faint on the map and never triggers an alert. It becomes a
          possible fire when it is seen again hours later or confirmed by another kind of report.
        </li>
        <li>Known industrial heat sources (refineries, gas flares, steel mills) are filtered out.</li>
      </ul>

      <h2>Data sources</h2>
      <ul>
        <li>
          Satellite fire detections: we acknowledge the use of data from NASA&apos;s Fire Information for Resource
          Management System (<a href="https://earthdata.nasa.gov/firms">FIRMS</a>), part of NASA&apos;s Earth Science Data
          and Information System (ESDIS), from the VIIRS and MODIS instruments.
        </li>
        <li>
          Geostationary fire detections: NOAA GOES-18 and GOES-19 ABI Fire/Hot Spot Characterization, from{" "}
          <a href="https://www.noaa.gov/information-technology/open-data-dissemination">NOAA Open Data Dissemination</a>.
        </li>
        <li>
          Official fires and perimeters: <a href="https://data-nifc.opendata.arcgis.com/">NIFC WFIGS</a>.
        </li>
        <li>
          Evacuation orders, fire warnings, red flag warnings and smoke alerts:{" "}
          <a href="https://www.weather.gov/">National Weather Service</a>.
        </li>
        <li>
          Air quality: data courtesy of <a href="https://www.airnow.gov/">AirNow</a> and its participating agencies. The
          data are preliminary and unvalidated.
        </li>
        <li>
          Wind and forecast weather: <a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a> (CC BY 4.0).
        </li>
        <li>
          Fire danger and drought inputs to the spread forecast:{" "}
          <a href="https://www.climatologylab.org/gridmet.html">gridMET</a>, University of California Merced.
        </li>
        <li>Place names and address search: US Census Bureau Geocoder, Photon by komoot and OpenStreetMap Nominatim, with OpenStreetMap data © OpenStreetMap contributors (ODbL).</li>
        <li>
          Maps: Natural Earth; Esri World Topographic Map; Sentinel-2 cloudless by EOX IT Services GmbH (contains
          modified Copernicus Sentinel data).
        </li>
        <li>Spread forecast: the FireSight model, trained on the Next Day Wildfire Spread dataset.</li>
      </ul>
    </DocPage>
  );
}
