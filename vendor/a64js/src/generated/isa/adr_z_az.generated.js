export const ENCODINGS = [
    {
        "instructionId": "adr_z_az",
        "encodingId": "adr_z_az_d_s32_scaled",
        "mnemonic": "ADR",
        "className": "Unpacked 32-bit signed offsets",
        "fileName": "adr_z_az.xml",
        "mask": 4292931584,
        "value": 69246976,
        "bitCount": 15,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "msz",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-adr-vector"
    },
    {
        "instructionId": "adr_z_az",
        "encodingId": "adr_z_az_d_u32_scaled",
        "mnemonic": "ADR",
        "className": "Unpacked 32-bit unsigned offsets",
        "fileName": "adr_z_az.xml",
        "mask": 4292931584,
        "value": 73441280,
        "bitCount": 15,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "msz",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-adr-vector"
    },
    {
        "instructionId": "adr_z_az",
        "encodingId": "adr_z_az_sd_same_scaled",
        "mnemonic": "ADR",
        "className": "Packed offsets",
        "fileName": "adr_z_az.xml",
        "mask": 4288737280,
        "value": 77635584,
        "bitCount": 14,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "msz",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-adr-vector"
    }
];
